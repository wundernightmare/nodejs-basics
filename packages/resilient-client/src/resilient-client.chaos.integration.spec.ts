import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { integration, meta, proxiedPort, testCase } from "@base/testing";
import type { Proxy } from "@base/testing";

import { ResilientClient } from "./resilient-client.js";
import type { ResilientClientConfig } from "./resilient-client.js";

/**
 * The client against a network that misbehaves. A real HTTP server (this
 * process) sits behind Toxiproxy; each test breaks the path in one way and
 * states what the caller sees, how long it takes, what the server received
 * and what the breaker concluded. The unit suite proves the rules against a
 * scripted dispatcher; this one proves they hold on real sockets, where a
 * timeout is a connection that says nothing and a reset is an RST.
 */
const infra = integration("toxiproxy");

async function timed<T>(run: () => Promise<T>): Promise<{ ms: number; outcome: T | Error }> {
  const started = Date.now();
  const outcome = await run().catch((err: unknown) => err as Error);
  return { ms: Date.now() - started, outcome };
}

describe.skipIf(infra.skip)("ResilientClient under network faults (chaos)", () => {
  meta({
    epic: "nodejs-basics",
    feature: "resilient-client",
    owner: "@team-platform",
    tags: ["http-client", "chaos", "integration"],
  });

  let server: Server;
  let proxy: Proxy;
  let baseUrl: string;
  /** Requests the server received, as "METHOD path". */
  let received: string[];
  /** Called for every request the server receives, before it answers. */
  let onRequest: (() => void) | undefined;
  const clients: ResilientClient[] = [];

  beforeAll(async () => {
    received = [];
    server = createServer((req, res) => {
      received.push(`${req.method} ${req.url}`);
      onRequest?.();
      req.resume();
      req.on("end", () => {
        if (req.url === "/big") {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("x".repeat(64 * 1024));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    // 0.0.0.0: the proxy reaches this server from its container.
    await new Promise<void>((resolve) => {
      server.listen(0, "0.0.0.0", resolve);
    });
    proxy = await proxiedPort("rc-chaos", (server.address() as AddressInfo).port);
    baseUrl = `http://${proxy.address}`;
  });

  afterEach(async () => {
    await proxy.reset();
    await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
    received = [];
    onRequest = undefined;
  });

  afterAll(async () => {
    await proxy.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  function client(overrides: ResilientClientConfig = {}): ResilientClient {
    const c = new ResilientClient(baseUrl, {
      connections: 2,
      attemptTimeoutMs: 300,
      retry: { maxRetries: 2, minTimeout: 10, maxTimeout: 20 },
      circuitBreaker: { volumeThreshold: 100 },
      ...overrides,
    });
    clients.push(c);
    return c;
  }

  it("answers through the proxy when the path is healthy", async () => {
    await testCase("NB-1147", "chaos baseline: the proxied path works");
    const res = await client().request({ path: "/ok", method: "GET" });
    expect(res.statusCode).toBe(200);
    expect(await res.body.json()).toEqual({ ok: true });
    expect(received).toEqual(["GET /ok"]);
  });

  it("a slow dependency: each attempt is cancelled at its timeout, a GET is retried", async () => {
    await testCase("NB-1148", "latency beyond the attempt timeout: bounded time, retried GET");
    await proxy.latency(2_000);
    const { ms, outcome } = await timed(() => client().request({ path: "/slow", method: "GET" }));
    expect(outcome).toMatchObject({ errorType: "timeout", kind: "transient" });
    // Three attempts of 300 ms and two short backoffs — not 3 × 2 s.
    expect(ms).toBeGreaterThanOrEqual(850);
    expect(ms).toBeLessThan(1_800);
    expect(received).toEqual(["GET /slow", "GET /slow", "GET /slow"]);
  });

  it("a slow dependency: a POST is sent once, never repeated", async () => {
    await testCase("NB-1149", "latency beyond the attempt timeout: a POST is not retried");
    await proxy.latency(2_000);
    const { ms, outcome } = await timed(() =>
      client().request({ path: "/orders", method: "POST", body: "{}" }),
    );
    expect(outcome).toMatchObject({ errorType: "timeout" });
    expect(ms).toBeLessThan(900);
    expect(received).toEqual(["POST /orders"]);
  });

  it("a slow dependency recovers: the retry that fits the timeout succeeds", async () => {
    await testCase("NB-1150", "a retry succeeds once the latency is gone");
    await proxy.latency(2_000);
    // The dependency gets well while the second attempt is on its way.
    onRequest = (): void => {
      if (received.length === 2) void proxy.reset();
    };
    const res = await client().request({ path: "/flaky", method: "GET" });
    expect(res.statusCode).toBe(200);
    expect(received).toEqual(["GET /flaky", "GET /flaky"]);
  });

  it("a connection that goes silent does not hang the caller", async () => {
    await testCase("NB-1151", "a black-holed connection ends at the attempt timeout");
    // Data stops flowing and the connection stays open: no RST, no FIN.
    await proxy.toxic("timeout", { timeout: 0 });
    const { ms, outcome } = await timed(() =>
      client({ retry: { maxRetries: 0 } }).request({ path: "/void", method: "GET" }),
    );
    expect(outcome).toMatchObject({ errorType: "timeout", kind: "transient" });
    expect(ms).toBeGreaterThanOrEqual(280);
    expect(ms).toBeLessThan(1_000);
  });

  it("the caller's budget ends the call before the attempt timeout would", async () => {
    await testCase("NB-1152", "a request deadline shorter than the attempt timeout wins");
    await proxy.latency(2_000);
    const deadline = Date.now() + 120;
    const { ms, outcome } = await timed(() =>
      client({ getRemainingMs: () => deadline - Date.now() }).request({
        path: "/slow",
        method: "GET",
      }),
    );
    expect(outcome).toMatchObject({ errorType: "deadline_exceeded", kind: "fatal" });
    expect(ms).toBeLessThan(280);
    expect(received).toEqual(["GET /slow"]);
  });

  it("connections reset by the peer: a transient network error, retried for a GET", async () => {
    await testCase("NB-1153", "RST from the dependency: retried, then reported as a network error");
    await proxy.toxic("reset_peer", { timeout: 0 });
    const c = client();
    const { ms, outcome } = await timed(() => c.request({ path: "/rst", method: "GET" }));
    expect(outcome).toMatchObject({ errorType: "network", kind: "transient" });
    expect(c.retries).toBe(2);
    expect(ms).toBeLessThan(1_500);
  });

  it("a dependency that is down opens the breaker; calls then fail fast without dialling", async () => {
    await testCase("NB-1154", "outage: breaker opens, fails fast, closes after a successful probe");
    await proxy.down();
    const c = client({
      retry: { maxRetries: 0 },
      circuitBreaker: { volumeThreshold: 3, errorThresholdPercentage: 50, resetTimeout: 300 },
    });
    for (let i = 0; i < 3; i++) {
      const { outcome } = await timed(() => c.request({ path: "/x", method: "GET" }));
      expect(outcome).toMatchObject({ errorType: "network", kind: "transient" });
    }
    expect(c.breakerState).toBe("open");

    const { ms, outcome } = await timed(() => c.request({ path: "/x", method: "GET" }));
    expect(outcome).toMatchObject({ errorType: "circuit_open" });
    expect(ms).toBeLessThan(50);
    expect(received).toEqual([]);

    // The dependency comes back; after resetTimeout one probe goes out and closes the breaker.
    await proxy.up();
    await expect.poll(() => c.breakerState, { timeout: 2_000 }).toBe("halfOpen");
    expect((await c.request({ path: "/back", method: "GET" })).statusCode).toBe(200);
    expect(c.breakerState).toBe("closed");
    expect(received).toEqual(["GET /back"]);
    expect(c.breakerTransitions).toEqual([
      { from: "closed", to: "open", count: 1 },
      { from: "open", to: "halfOpen", count: 1 },
      { from: "halfOpen", to: "closed", count: 1 },
    ]);
  });

  it("an outage that outlasts the probe opens the breaker again", async () => {
    await testCase("NB-1155", "a failed half-open probe reopens the breaker");
    await proxy.down();
    const c = client({
      retry: { maxRetries: 0 },
      circuitBreaker: { volumeThreshold: 2, errorThresholdPercentage: 50, resetTimeout: 200 },
    });
    await timed(() => c.request({ path: "/x", method: "GET" }));
    await timed(() => c.request({ path: "/x", method: "GET" }));
    await expect.poll(() => c.breakerState, { timeout: 2_000 }).toBe("halfOpen");
    const { outcome } = await timed(() => c.request({ path: "/probe", method: "GET" }));
    expect(outcome).toMatchObject({ errorType: "network" });
    expect(c.breakerState).toBe("open");
  });

  it("a response cut off mid-body fails the read, and the next call gets a fresh connection", async () => {
    await testCase("NB-1156", "a truncated response is an error for the reader, not a short body");
    await proxy.toxic("limit_data", { bytes: 4_096 });
    const c = client({ retry: { maxRetries: 0 } });
    const res = await c.request({ path: "/big", method: "GET" });
    expect(res.statusCode).toBe(200);
    await expect(res.body.text()).rejects.toThrow();

    await proxy.reset();
    const again = await c.request({ path: "/big", method: "GET" });
    expect((await again.body.text()).length).toBe(64 * 1024);
  });
});
