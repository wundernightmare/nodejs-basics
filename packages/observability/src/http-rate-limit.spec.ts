import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { captureMetrics, meta, type MetricsCapture, metricValue, testCase } from "@base/testing";

import { registerHttpInstrumentation } from "./http-metrics.js";
import {
  parseTrustedProxies,
  type RateLimitConfig,
  RateLimiter,
  registerRateLimit,
  TokenBucket,
} from "./http-rate-limit.js";

const OFF: RateLimitConfig = {
  rate: 0,
  burst: 0,
  perClientRate: 0,
  perClientBurst: 0,
  maxClients: 10_000,
};

const get = (target: FastifyInstance, remoteAddress = "10.0.0.1", headers = {}) =>
  target.inject({ method: "GET", url: "/tasks/1?x=1", remoteAddress, headers });

describe("inbound rate limit", () => {
  meta({
    epic: "nodejs-basics",
    feature: "observability",
    owner: "@team-platform",
    tags: ["rate-limit", "unit"],
  });

  let capture: MetricsCapture;
  let app: FastifyInstance | undefined;
  let now = 0;
  const clock = (): number => now;

  async function server(
    config: Partial<RateLimitConfig>,
    options: { trustProxy?: string[] | false } = {},
  ): Promise<FastifyInstance> {
    app = Fastify({ trustProxy: options.trustProxy ?? false });
    registerHttpInstrumentation(app);
    registerRateLimit(app, { ...OFF, ...config }, clock);
    app.get("/tasks/:id", () => ({ ok: true }));
    await app.ready();
    return app;
  }

  beforeEach(() => {
    capture = captureMetrics();
    now = 0;
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await capture.stop();
  });

  it("the global bucket: a burst passes, the next request is a 429 problem with Retry-After, a refill lets one more through", async () => {
    await testCase("NB-1242", "Rate limit: global token bucket, 429 + Retry-After, exact refill");
    const target = await server({ rate: 2, burst: 3 });

    for (let i = 0; i < 3; i += 1) expect((await get(target)).statusCode).toBe(200);
    const refused = await get(target);
    expect(refused.statusCode).toBe(429);
    expect(refused.headers["retry-after"]).toBe("1"); // 0.5 s to the next token, rounded up
    expect(refused.headers["content-type"]).toContain("application/problem+json");
    expect(refused.json()).toMatchObject({
      type: "about:blank",
      title: "Too Many Requests",
      status: 429,
      detail: "rate limit exceeded; retry after the time in Retry-After",
      instance: "/tasks/1",
    });
    expect(refused.json<{ request_id: string }>().request_id).not.toBe("");

    now += 499;
    expect((await get(target)).statusCode).toBe(429);
    now += 1; // half a second at 2/s: exactly one token
    expect((await get(target)).statusCode).toBe(200);
    expect((await get(target)).statusCode).toBe(429);

    const text = await capture.scrape();
    expect(metricValue(text, "http_rate_limited_total", { scope: "global" })).toBe(3);
    expect(metricValue(text, "http_rate_limited_total", { scope: "client" })).toBe(-1);
    // A refused request is still a request: counted with its status.
    expect(metricValue(text, "http_requests_total", { status: "429" })).toBe(3);
  });

  it("the per-client bucket limits one address and leaves the others alone", async () => {
    await testCase("NB-1243", "Rate limit: per client address");
    const target = await server({ perClientRate: 1, perClientBurst: 2 });

    expect((await get(target, "10.0.0.1")).statusCode).toBe(200);
    expect((await get(target, "10.0.0.1")).statusCode).toBe(200);
    const refused = await get(target, "10.0.0.1");
    expect(refused.statusCode).toBe(429);
    expect(refused.headers["retry-after"]).toBe("1");
    expect((await get(target, "10.0.0.2")).statusCode).toBe(200);

    const text = await capture.scrape();
    expect(metricValue(text, "http_rate_limited_total", { scope: "client" })).toBe(1);
  });

  it("a client refused at its own bucket takes nothing from the global one", async () => {
    await testCase("NB-1244", "Rate limit: a refused client does not drain the global bucket");
    const target = await server({ rate: 1, burst: 2, perClientRate: 1, perClientBurst: 1 });

    expect((await get(target, "10.0.0.1")).statusCode).toBe(200); // global: 1 left
    for (let i = 0; i < 20; i += 1) expect((await get(target, "10.0.0.1")).statusCode).toBe(429);
    expect((await get(target, "10.0.0.2")).statusCode).toBe(200); // the token is still there
    expect((await get(target, "10.0.0.3")).statusCode).toBe(429); // now the global bucket is empty

    const text = await capture.scrape();
    expect(metricValue(text, "http_rate_limited_total", { scope: "client" })).toBe(20);
    expect(metricValue(text, "http_rate_limited_total", { scope: "global" })).toBe(1);
  });

  it("the client table is bounded: refilled buckets go first, otherwise a new client is refused", async () => {
    await testCase("NB-1245", "Rate limit: the client table cannot grow without bound");
    const limiter = new RateLimiter(
      { ...OFF, perClientRate: 1, perClientBurst: 1, maxClients: 3 },
      clock,
    );
    for (const client of ["a", "b", "c"]) expect(limiter.decide(client).allowed).toBe(true);
    expect(limiter.clients).toBe(3);

    // Everyone is mid-burst: nothing to evict, the newcomer is shed.
    expect(limiter.decide("d")).toEqual({ allowed: false, scope: "client", retryAfterSeconds: 1 });
    expect(limiter.clients).toBe(3);
    // A known client keeps its bucket (and its own refusal).
    expect(limiter.decide("a")).toEqual({ allowed: false, scope: "client", retryAfterSeconds: 1 });

    now += 1000; // all three have refilled: they make room
    expect(limiter.decide("d").allowed).toBe(true);
    expect(limiter.clients).toBe(1);
  });

  it("is off by default — no hook, no metric series — and refuses negative settings", async () => {
    await testCase("NB-1246", "Rate limit: off unless a rate is set; settings are validated");
    const target = await server({});
    for (let i = 0; i < 50; i += 1) expect((await get(target)).statusCode).toBe(200);
    expect(await capture.scrape()).not.toContain("http_rate_limited_total");

    expect(() => registerRateLimit(Fastify(), { ...OFF, rate: -1 })).toThrow(/rate must be/u);
    expect(() => registerRateLimit(Fastify(), { ...OFF, perClientBurst: Number.NaN })).toThrow(
      /perClientBurst/u,
    );
  });

  it("behind a trusted proxy the client is the first untrusted hop of X-Forwarded-For", async () => {
    await testCase("NB-1247", "Rate limit: client identity behind HTTP_TRUSTED_PROXIES");
    const trustProxy = parseTrustedProxies("10.0.0.0/8, 192.168.1.1");
    expect(trustProxy).toEqual(["10.0.0.0/8", "192.168.1.1"]);
    expect(parseTrustedProxies(" , ")).toBe(false);
    const target = await server({ perClientRate: 1, perClientBurst: 1 }, { trustProxy });

    const via = (forwarded: string, peer = "10.0.0.9") =>
      get(target, peer, { "x-forwarded-for": forwarded });
    expect((await via("203.0.113.7")).statusCode).toBe(200);
    expect((await via("203.0.113.7")).statusCode).toBe(429); // the same client through the proxy
    expect((await via("203.0.113.8")).statusCode).toBe(200);
    // A spoofed left-most entry does not help: the walk stops at the first untrusted hop.
    expect((await via("1.2.3.4, 203.0.113.7")).statusCode).toBe(429);
    // An untrusted peer's header is ignored: the peer itself is the client.
    expect((await via("203.0.113.9", "198.51.100.1")).statusCode).toBe(200);
    expect((await via("203.0.113.10", "198.51.100.1")).statusCode).toBe(429);
  });

  it("a bucket starts full, never exceeds its depth and reports the wait without spending", async () => {
    await testCase("NB-1248", "Rate limit: token bucket arithmetic");
    const bucket = new TokenBucket(0.5, 0, 0); // depth max(1, ceil(0.5)) = 1
    expect(bucket.burst).toBe(1);
    expect(bucket.take(0)).toBe(0);
    expect(bucket.take(0)).toBe(2000);
    expect(bucket.take(1000)).toBe(1000); // asking does not push the refill away
    expect(bucket.take(2000)).toBe(0);
    expect(bucket.tokensAt(1_000_000)).toBe(1);
  });
});
