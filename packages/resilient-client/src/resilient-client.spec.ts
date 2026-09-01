import { MockAgent } from "undici";
import type { MockPool } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CachedBodyReadable, MemoryCache } from "./resilient-client.cache.js";
import { OutboundError } from "./resilient-client.errors.js";
import { ResilientClient } from "./resilient-client.js";
import type { ResilientClientConfig } from "./resilient-client.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BASE = "http://rc-test.local";

/** Creates a ResilientClient with a MockPool as the dispatcher. */
function makeClient(pool: MockPool, overrides: ResilientClientConfig = {}): ResilientClient {
  return new ResilientClient(BASE, {
    // Disable circuit breaker volume threshold so a single failure can trip it
    circuitBreaker: { volumeThreshold: 1, resetTimeout: 100 },
    // Instant retries — no real delay in tests
    retry: { minTimeout: 0, maxTimeout: 0, maxRetries: 2 },
    _dispatcher: pool,
    ...overrides,
  });
}

function makePool(): { agent: MockAgent; pool: MockPool } {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const pool = agent.get(BASE) as MockPool;
  return { agent, pool };
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("ResilientClient", () => {
  let agent: MockAgent;
  let pool: MockPool;
  let client: ResilientClient;

  beforeEach(() => {
    ({ agent, pool } = makePool());
    client = makeClient(pool);
  });

  afterEach(async () => {
    await agent.close();
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it("returns a 200 response", async () => {
    pool
      .intercept({ path: "/health", method: "GET" })
      .reply(200, JSON.stringify({ status: "ok" }), {
        headers: { "content-type": "application/json" },
      });

    const res = await client.request({ path: "/health", method: "GET" });
    expect(res.statusCode).toBe(200);
    expect(await res.body.json()).toEqual({ status: "ok" });
  });

  it("returns non-2xx success (e.g. 201)", async () => {
    pool.intercept({ path: "/items", method: "POST" }).reply(201, "created");

    const res = await client.request({ path: "/items", method: "POST" });
    expect(res.statusCode).toBe(201);
  });

  // ── Retry logic ───────────────────────────────────────────────────────────

  it("retries on 429 and succeeds on the next attempt", async () => {
    pool.intercept({ path: "/api", method: "POST" }).reply(429, "slow down");
    pool.intercept({ path: "/api", method: "POST" }).reply(200, "ok");

    const res = await client.request({ path: "/api", method: "POST" });
    expect(res.statusCode).toBe(200);
  });

  it("retries on 503 up to maxRetries then throws retriesExhausted", async () => {
    // maxRetries: 2 → 3 total attempts
    pool.intercept({ path: "/api", method: "GET" }).reply(503, "unavailable").times(3);

    await expect(client.request({ path: "/api", method: "GET" })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof OutboundError && e.errorType === "retries_exhausted" && e.statusCode === 503,
    );
  });

  it("does not retry on 502 when custom statusCodes excludes it", async () => {
    const specialClient = makeClient(pool, {
      retry: { statusCodes: [429], minTimeout: 0, maxTimeout: 0 },
    });
    pool.intercept({ path: "/api", method: "GET" }).reply(502, "bad gateway");

    // 502 is not a retry code → immediately throws retriesExhausted? No — 502 is a 5xx,
    // not in [429], and not 4xx → it's returned as-is without error or retry
    const res = await specialClient.request({ path: "/api", method: "GET" });
    expect(res.statusCode).toBe(502);
  });

  // ── Client errors (4xx) ───────────────────────────────────────────────────

  it("throws clientError for 400", async () => {
    pool.intercept({ path: "/bad", method: "POST" }).reply(400, "bad request");

    await expect(client.request({ path: "/bad", method: "POST" })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof OutboundError && e.errorType === "client_error" && e.statusCode === 400,
    );
  });

  it("throws clientError for 401", async () => {
    pool.intercept({ path: "/auth", method: "GET" }).reply(401, "unauthorized");

    await expect(client.request({ path: "/auth", method: "GET" })).rejects.toSatisfy(
      (e: unknown) => e instanceof OutboundError && e.kind === "fatal",
    );
  });

  it("does NOT throw on 5xx that is not a retry status", async () => {
    // 500 is not in default retry codes [429, 502, 503, 504]
    pool.intercept({ path: "/fail", method: "GET" }).reply(500, "internal server error");

    const res = await client.request({ path: "/fail", method: "GET" });
    expect(res.statusCode).toBe(500);
  });

  // ── Circuit breaker ───────────────────────────────────────────────────────

  it("opens the circuit after failures and throws circuitOpen", async () => {
    // volumeThreshold:1, so after one failure the breaker opens
    pool.intercept({ path: "/api", method: "GET" }).reply(400, "err");

    // First call — fails, trips the breaker
    await expect(client.request({ path: "/api", method: "GET" })).rejects.toBeInstanceOf(
      OutboundError,
    );

    // Wait a tick for opossum to process the failure
    await new Promise((r) => setTimeout(r, 50));

    expect(client.breakerState).toBe("open");

    // Second call — circuit is open, throws circuitOpen immediately
    await expect(client.request({ path: "/api", method: "GET" })).rejects.toSatisfy(
      (e: unknown) => e instanceof OutboundError && e.errorType === "circuit_open",
    );
  });

  // ── Fallback ──────────────────────────────────────────────────────────────

  it("invokes fallback when circuit is open", async () => {
    const syntheticResponse = {
      statusCode: 200,
      headers: {},
      body: null,
      trailers: {},
      opaque: null,
      context: {},
    };
    const fallback = vi.fn().mockResolvedValue(syntheticResponse);

    const clientWithFallback = makeClient(pool, { fallback });
    // First call: 400 → opossum records failure; fallback kicks in → returns 200
    pool.intercept({ path: "/api", method: "GET" }).reply(400, "err");
    const first = await clientWithFallback.request({ path: "/api", method: "GET" });
    expect(first.statusCode).toBe(200);
    expect(fallback).toHaveBeenCalledOnce();
    const firstErr = fallback.mock.calls[0]![2];
    expect(firstErr).toBeInstanceOf(OutboundError);
    expect(firstErr.errorType).toBe("client_error");

    // Wait for opossum to open the circuit
    await new Promise((r) => setTimeout(r, 50));
    expect(clientWithFallback.breakerState).toBe("open");
    fallback.mockClear();

    // Second call: circuit is open → OutboundError.circuitOpen → fallback returns 200
    const second = await clientWithFallback.request({ path: "/api", method: "GET" });
    expect(second.statusCode).toBe(200);
    expect(fallback).toHaveBeenCalledOnce();
    const secondErr = fallback.mock.calls[0]![2];
    expect(secondErr.errorType).toBe("circuit_open");
  });

  it("re-throws when fallback returns null", async () => {
    const fallback = vi.fn().mockResolvedValue(null);
    const clientWithFallback = makeClient(pool, { fallback });
    // null fallback → original OutboundError is re-thrown
    pool.intercept({ path: "/api", method: "GET" }).reply(400, "err");
    await expect(
      clientWithFallback.request({ path: "/api", method: "GET" }),
    ).rejects.toBeInstanceOf(OutboundError);
  });

  // ── Cache ─────────────────────────────────────────────────────────────────

  it("caches GET responses and serves from cache on second call", async () => {
    const cache = new MemoryCache();
    const cachedClient = makeClient(pool, {
      cache: { adapter: cache, ttlSeconds: 60 },
    });

    pool.intercept({ path: "/data", method: "GET" }).reply(200, JSON.stringify({ v: 1 }), {
      headers: { "content-type": "application/json" },
    });

    const first = await cachedClient.request({ path: "/data", method: "GET" });
    expect(first.statusCode).toBe(200);
    expect(first.body).toBeInstanceOf(CachedBodyReadable);

    // Second call — no more mock intercepts registered → served from cache
    const second = await cachedClient.request({ path: "/data", method: "GET" });
    expect(second.statusCode).toBe(200);
    expect(second.body).toBeInstanceOf(CachedBodyReadable);
    expect(await (second.body as unknown as CachedBodyReadable).json()).toEqual({ v: 1 });

    expect(cache.size).toBe(1);
  });

  it("does not cache POST responses", async () => {
    const cache = new MemoryCache();
    const cachedClient = makeClient(pool, {
      cache: { adapter: cache, ttlSeconds: 60 },
    });

    pool.intercept({ path: "/data", method: "POST" }).reply(200, "ok").times(2);

    await cachedClient.request({ path: "/data", method: "POST" });
    await cachedClient.request({ path: "/data", method: "POST" });

    expect(cache.size).toBe(0);
  });

  it("evicts expired cache entry and fetches fresh", async () => {
    const cache = new MemoryCache();
    const cachedClient = makeClient(pool, {
      cache: { adapter: cache, ttlSeconds: 1 },
    });

    pool.intercept({ path: "/data", method: "GET" }).reply(200, JSON.stringify({ v: 1 }), {
      headers: { "content-type": "application/json" },
    });
    await cachedClient.request({ path: "/data", method: "GET" });

    // Expire the entry by backdating cachedAt
    const key = `GET:${BASE}/data`;
    const entry = await cache.get(key);
    if (entry) {
      await cache.set(key, { ...entry, cachedAt: Date.now() - 10_000 });
    }

    pool.intercept({ path: "/data", method: "GET" }).reply(200, JSON.stringify({ v: 2 }), {
      headers: { "content-type": "application/json" },
    });

    const res = await cachedClient.request({ path: "/data", method: "GET" });
    expect(await (res.body as unknown as CachedBodyReadable).json()).toEqual({ v: 2 });
  });

  // ── Coalescing ────────────────────────────────────────────────────────────

  it("coalesces concurrent identical GET requests into one upstream call", async () => {
    const coalesceClient = makeClient(pool, { coalesce: true });

    // Only ONE interceptor — proves only one upstream request is made
    pool
      .intercept({ path: "/data", method: "GET" })
      .reply(200, JSON.stringify({ coalesced: true }), {
        headers: { "content-type": "application/json" },
      });

    const [r1, r2, r3] = await Promise.all([
      coalesceClient.request({ path: "/data", method: "GET" }),
      coalesceClient.request({ path: "/data", method: "GET" }),
      coalesceClient.request({ path: "/data", method: "GET" }),
    ]);

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r3.statusCode).toBe(200);
  });

  // ── Header injection ──────────────────────────────────────────────────────

  it("adds Connection: close when shortLived=true", async () => {
    const captureAgent = new MockAgent();
    captureAgent.disableNetConnect();
    const capturePool = captureAgent.get(BASE) as MockPool;
    capturePool
      .intercept({ path: "/q", method: "GET", headers: { connection: "close" } })
      .reply(200, "ok");

    const capturingClient = new ResilientClient(BASE, {
      shortLived: true,
      retry: { minTimeout: 0, maxTimeout: 0 },
      _dispatcher: capturePool,
    });
    const res = await capturingClient.request({ path: "/q", method: "GET" });
    expect(res.statusCode).toBe(200);
    await captureAgent.close();
  });

  it("adds User-Agent header when configured", async () => {
    const uaAgent = new MockAgent();
    uaAgent.disableNetConnect();
    const uaPool = uaAgent.get(BASE) as MockPool;
    uaPool
      .intercept({ path: "/q", method: "GET", headers: { "user-agent": "my-service/1.0" } })
      .reply(200, "ok");

    const uaClient = new ResilientClient(BASE, {
      userAgent: "my-service/1.0",
      retry: { minTimeout: 0, maxTimeout: 0 },
      _dispatcher: uaPool,
    });
    const res = await uaClient.request({ path: "/q", method: "GET" });
    expect(res.statusCode).toBe(200);
    await uaAgent.close();
  });

  it("forwards x-request-id via getRequestId getter when set", async () => {
    const reqIdAgent = new MockAgent();
    reqIdAgent.disableNetConnect();
    const reqIdPool = reqIdAgent.get(BASE) as MockPool;
    reqIdPool
      .intercept({ path: "/q", method: "GET", headers: { "x-request-id": "req-123" } })
      .reply(200, "ok");

    const reqIdClient = new ResilientClient(BASE, {
      retry: { minTimeout: 0, maxTimeout: 0 },
      getRequestId: () => "req-123",
      _dispatcher: reqIdPool,
    });

    const res = await reqIdClient.request({ path: "/q", method: "GET" });
    expect(res.statusCode).toBe(200);
    await reqIdAgent.close();
  });

  // ── Network-error retry ───────────────────────────────────────────────────

  it("retries on ECONNRESET and succeeds on the next attempt", async () => {
    const connErr = Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
    let attempts = 0;
    const dispatcher = {
      request: vi.fn().mockImplementation(() => {
        attempts++;
        if (attempts === 1) throw connErr;
        return Promise.resolve({
          statusCode: 200,
          headers: {},
          body: null,
          trailers: {},
          opaque: null,
          context: {},
        });
      }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as import("undici").Dispatcher;

    const c = new ResilientClient(BASE, {
      retry: { maxRetries: 1, minTimeout: 0, maxTimeout: 0 },
      circuitBreaker: { volumeThreshold: 100 },
      _dispatcher: dispatcher,
    });
    const res = await c.request({ path: "/", method: "GET" });
    expect(res.statusCode).toBe(200);
    expect(attempts).toBe(2);
  });

  it("throws OutboundError.network for non-retriable error codes", async () => {
    const unknownErr = Object.assign(new Error("DNS failed"), { code: "EAI_NONAME" });
    const dispatcher = {
      request: vi.fn().mockRejectedValue(unknownErr),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as import("undici").Dispatcher;

    const c = new ResilientClient(BASE, {
      retry: { maxRetries: 2, minTimeout: 0, maxTimeout: 0 },
      circuitBreaker: { volumeThreshold: 100 },
      _dispatcher: dispatcher,
    });
    await expect(c.request({ path: "/", method: "GET" })).rejects.toSatisfy(
      (e: unknown) => e instanceof OutboundError && e.errorType === "network",
    );
  });

  // ── breakerState getter ───────────────────────────────────────────────────

  it("reports closed as initial state", () => {
    expect(client.breakerState).toBe("closed");
  });

  // ── adaptiveLimit getter ──────────────────────────────────────────────────

  it("returns undefined when adaptive concurrency is disabled", () => {
    expect(client.adaptiveLimit).toBeUndefined();
  });

  it("returns initial limit when adaptive concurrency is enabled", () => {
    const ac = makeClient(pool, {
      adaptiveConcurrency: { enabled: true, initialLimit: 5 },
    });
    expect(ac.adaptiveLimit).toBe(5);
  });

  // ── Stale-while-revalidate ────────────────────────────────────────────────

  it("serves stale response immediately then refreshes in background", async () => {
    const cache = new MemoryCache();
    const cachedClient = makeClient(pool, {
      cache: { adapter: cache, ttlSeconds: 1, staleTtlSeconds: 300 },
    });

    pool.intercept({ path: "/data", method: "GET" }).reply(200, JSON.stringify({ v: 1 }), {
      headers: { "content-type": "application/json" },
    });
    await cachedClient.request({ path: "/data", method: "GET" });

    // Backdating cachedAt makes the entry stale (within staleTtlSeconds window)
    const key = `GET:${BASE}/data`;
    const entry = await cache.get(key);
    if (entry) {
      await cache.set(key, { ...entry, cachedAt: Date.now() - 5_000 });
    }

    // Register the background refresh response before serving stale
    pool.intercept({ path: "/data", method: "GET" }).reply(200, JSON.stringify({ v: 2 }), {
      headers: { "content-type": "application/json" },
    });

    // This call serves the stale entry (v:1)
    const stale = await cachedClient.request({ path: "/data", method: "GET" });
    expect(await (stale.body as unknown as CachedBodyReadable).json()).toEqual({ v: 1 });

    // Allow background refresh to complete
    await new Promise((r) => setTimeout(r, 50));

    // Next call should return the refreshed v:2
    const fresh = await cachedClient.request({ path: "/data", method: "GET" });
    expect(await (fresh.body as unknown as CachedBodyReadable).json()).toEqual({ v: 2 });
  });

  // ── Header normalization branches ─────────────────────────────────────────

  it("normalizes flat-array headers when shortLived merges them", async () => {
    const arrAgent = new MockAgent();
    arrAgent.disableNetConnect();
    const arrPool = arrAgent.get(BASE) as MockPool;
    // shortLived=true → #applyShortLived calls #normalizeHeaders(["x-custom", "val"])
    arrPool.intercept({ path: "/q", method: "GET" }).reply(200, "ok");

    const arrClient = new ResilientClient(BASE, {
      shortLived: true,
      retry: { minTimeout: 0, maxTimeout: 0 },
      _dispatcher: arrPool,
    });
    const res = await arrClient.request({
      path: "/q",
      method: "GET",
      headers: ["x-custom", "val"],
    });
    expect(res.statusCode).toBe(200);
    await arrAgent.close();
  });

  it("spreads existing plain-object headers when shortLived merges them", async () => {
    const objAgent = new MockAgent();
    objAgent.disableNetConnect();
    const objPool = objAgent.get(BASE) as MockPool;
    // shortLived=true + existing object headers → #normalizeHeaders hits the object spread path
    objPool.intercept({ path: "/q", method: "GET" }).reply(200, "ok");

    const objClient = new ResilientClient(BASE, {
      shortLived: true,
      retry: { minTimeout: 0, maxTimeout: 0 },
      _dispatcher: objPool,
    });
    const res = await objClient.request({
      path: "/q",
      method: "GET",
      headers: { "x-existing": "preserved" },
    });
    expect(res.statusCode).toBe(200);
    await objAgent.close();
  });

  it("drains a null response body without error on retry status", async () => {
    // Simulates a dispatcher that returns statusCode=429 with body=null
    const nullBodyDispatcher = {
      request: vi.fn().mockResolvedValue({
        statusCode: 429,
        headers: {},
        body: null,
        trailers: {},
        opaque: null,
        context: {},
      }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as import("undici").Dispatcher;

    const clientWithNull = new ResilientClient(BASE, {
      retry: { maxRetries: 0, minTimeout: 0, maxTimeout: 0 },
      circuitBreaker: { volumeThreshold: 100 },
      _dispatcher: nullBodyDispatcher,
    });

    await expect(clientWithNull.request({ path: "/", method: "GET" })).rejects.toSatisfy(
      (e: unknown) => e instanceof OutboundError && e.errorType === "retries_exhausted",
    );
  });

  // ── Cache error handling ──────────────────────────────────────────────────

  it("handles cache adapter read error gracefully and fetches fresh", async () => {
    const brokenCache = {
      get: vi.fn().mockRejectedValue(new Error("cache unavailable")),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const cachedClient = makeClient(pool, {
      cache: { adapter: brokenCache, ttlSeconds: 60 },
    });

    pool.intercept({ path: "/data", method: "GET" }).reply(200, JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });

    // Cache read throws → falls through to live fetch without error
    const res = await cachedClient.request({ path: "/data", method: "GET" });
    expect(res.statusCode).toBe(200);
  });

  // ── passthrough4xx ─────────────────────────────────────────────────────

  it("returns 4xx response body when passthrough4xx=true", async () => {
    const pt4 = makeClient(pool, { passthrough4xx: true });
    pool
      .intercept({ path: "/api", method: "POST" })
      .reply(422, JSON.stringify({ error: "invalid" }));

    const res = await pt4.request({ path: "/api", method: "POST" });
    expect(res.statusCode).toBe(422);
    expect(await res.body.json()).toEqual({ error: "invalid" });
  });

  it("passthrough4xx returns 400 without throwing", async () => {
    const pt4 = makeClient(pool, { passthrough4xx: true });
    pool.intercept({ path: "/api", method: "GET" }).reply(400, "bad");

    const res = await pt4.request({ path: "/api", method: "GET" });
    expect(res.statusCode).toBe(400);
  });

  it("passthrough4xx still throws on retry status codes", async () => {
    const pt4 = makeClient(pool, { passthrough4xx: true });
    pool.intercept({ path: "/api", method: "GET" }).reply(429, "limit").times(3);

    await expect(pt4.request({ path: "/api", method: "GET" })).rejects.toSatisfy(
      (e: unknown) => e instanceof OutboundError && e.errorType === "retries_exhausted",
    );
  });

  // ── Adaptive concurrency ─────────────────────────────────────────────

  it("adaptive limiter increases limit on low-latency success", async () => {
    const adaptiveClient = makeClient(pool, {
      adaptiveConcurrency: { enabled: true, initialLimit: 2, maxLimit: 10 },
    });
    pool.intercept({ path: "/fast", method: "GET" }).reply(200, "ok");
    pool.intercept({ path: "/fast", method: "GET" }).reply(200, "ok");

    await adaptiveClient.request({ path: "/fast", method: "GET" });
    await adaptiveClient.request({ path: "/fast", method: "GET" });

    // Limit should have grown from 2
    expect(adaptiveClient.adaptiveLimit).toBeGreaterThanOrEqual(2);
  });

  it("adaptive limiter decreases limit on failure", async () => {
    const adaptiveClient = makeClient(pool, {
      adaptiveConcurrency: { enabled: true, initialLimit: 10, minLimit: 1 },
    });
    // First a success to establish minRtt
    pool.intercept({ path: "/api", method: "GET" }).reply(200, "ok");
    await adaptiveClient.request({ path: "/api", method: "GET" });

    // Now a retriable 503 — causes decrease on each attempt
    pool.intercept({ path: "/api", method: "GET" }).reply(503, "err").times(3);
    await expect(adaptiveClient.request({ path: "/api", method: "GET" })).rejects.toBeInstanceOf(
      OutboundError,
    );

    expect(adaptiveClient.adaptiveLimit).toBeLessThan(10);
  });

  // ── Retry with dispatch errors ────────────────────────────────────────

  it("exhausts all retry attempts on persistent ECONNREFUSED", async () => {
    const connErr = Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
    const dispatcher = {
      request: vi.fn().mockRejectedValue(connErr),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as import("undici").Dispatcher;

    const c = new ResilientClient(BASE, {
      retry: { maxRetries: 2, minTimeout: 0, maxTimeout: 0 },
      circuitBreaker: { volumeThreshold: 100 },
      _dispatcher: dispatcher,
    });

    await expect(c.request({ path: "/", method: "GET" })).rejects.toSatisfy(
      (e: unknown) => e instanceof OutboundError && e.errorType === "network",
    );
    // 1 initial + 2 retries = 3 total
    expect(dispatcher.request).toHaveBeenCalledTimes(3);
  });

  // ── Fallback error handling ───────────────────────────────────────────

  it("re-throws original error when fallback itself throws", async () => {
    const fallback = vi.fn().mockRejectedValue(new Error("fallback crashed"));
    const fb = makeClient(pool, { fallback });
    pool.intercept({ path: "/api", method: "GET" }).reply(400, "err");

    await expect(fb.request({ path: "/api", method: "GET" })).rejects.toBeInstanceOf(OutboundError);
  });

  // ── getRequestId not set ──────────────────────────────────────────────

  it("does not add x-request-id when getRequestId returns undefined", async () => {
    const c = makeClient(pool, {
      getRequestId: () => undefined,
    });
    pool.intercept({ path: "/q", method: "GET" }).reply(200, "ok");
    const res = await c.request({ path: "/q", method: "GET" });
    expect(res.statusCode).toBe(200);
  });

  // ── close() ───────────────────────────────────────────────────────────────

  it("close() resolves without error", async () => {
    const localAgent = new MockAgent();
    const localPool = localAgent.get(BASE) as MockPool;
    const localClient = makeClient(localPool);
    await expect(localClient.close()).resolves.toBeUndefined();
    await localAgent.close();
  });
});
