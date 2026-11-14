import { type AddressInfo, createServer, type Socket } from "node:net";
import { Readable } from "node:stream";

import type { Dispatcher } from "undici";
import { describe, expect, it, vi } from "vitest";

import { testCase } from "@base/testing";

import { ResilientClient } from "./resilient-client.js";
import type { ResilientClientConfig } from "./resilient-client.js";

/**
 * The guarantees the client shares with golang-basics' resilient-http-client:
 * what is retried, how long an attempt may take, what the breaker counts.
 * A scripted dispatcher stands in for the network so every attempt is counted.
 */

const BASE = "http://guarantees.local";

type Step =
  | { status: number; headers?: Record<string, string>; body?: string }
  | { error: NodeJS.ErrnoException }
  | { hangMs: number };

function reply(status: number, headers: Record<string, string> = {}, body = ""): Step {
  return { status, headers, body };
}

function errno(code: string): Step {
  return { error: Object.assign(new Error(code), { code }) };
}

/** A dispatcher that plays `steps` in order (the last one repeats) and records each attempt. */
function scripted(steps: Step[]): {
  dispatcher: Dispatcher;
  calls: Dispatcher.RequestOptions[];
} {
  const calls: Dispatcher.RequestOptions[] = [];
  const request = vi.fn((opts: Dispatcher.RequestOptions) => {
    const step = steps[Math.min(calls.length, steps.length - 1)]!;
    calls.push(opts);
    if ("error" in step) return Promise.reject(step.error);
    if ("hangMs" in step) {
      return new Promise((resolve, reject) => {
        const signal = opts.signal as AbortSignal | undefined;
        const timer = setTimeout(() => {
          resolve({ statusCode: 200, headers: {}, body: Readable.from(["late"]) });
        }, step.hangMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason as Error);
        });
      });
    }
    return Promise.resolve({
      statusCode: step.status,
      headers: step.headers ?? {},
      body: Readable.from([step.body ?? ""]),
    });
  });
  return {
    dispatcher: { request, close: () => Promise.resolve() } as unknown as Dispatcher,
    calls,
  };
}

function client(dispatcher: Dispatcher, overrides: ResilientClientConfig = {}): ResilientClient {
  return new ResilientClient(BASE, {
    retry: { minTimeout: 0, maxTimeout: 0, maxRetries: 2 },
    circuitBreaker: { volumeThreshold: 100 },
    _dispatcher: dispatcher,
    ...overrides,
  });
}

describe("ResilientClient — what is retried", () => {
  it.each(["POST", "PATCH"] as const)(
    "does not retry %s: it may not be sent twice",
    async (method) => {
      await testCase("NB-1110", "only idempotent requests are retried");
      const { dispatcher, calls } = scripted([reply(503)]);
      await expect(client(dispatcher).request({ path: "/orders", method })).rejects.toMatchObject({
        statusCode: 503,
        kind: "transient",
      });
      expect(calls).toHaveLength(1);
    },
  );

  it.each(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"] as const)("retries %s", async (method) => {
    await testCase("NB-1110", "only idempotent requests are retried");
    const { dispatcher, calls } = scripted([reply(503), reply(200)]);
    const res = await client(dispatcher).request({ path: "/x", method });
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("retries a POST that carries an Idempotency-Key", async () => {
    await testCase("NB-1111", "an Idempotency-Key makes a POST retryable");
    const { dispatcher, calls } = scripted([errno("ECONNRESET"), reply(201)]);
    const res = await client(dispatcher).request({
      path: "/orders",
      method: "POST",
      headers: { "Idempotency-Key": "k-1" },
      body: "{}",
    });
    expect(res.statusCode).toBe(201);
    expect(calls).toHaveLength(2);
  });

  it("does not retry a body that cannot be replayed (a stream)", async () => {
    await testCase("NB-1112", "a streamed body is sent once");
    const { dispatcher, calls } = scripted([reply(503), reply(200)]);
    await expect(
      client(dispatcher).request({ path: "/x", method: "PUT", body: Readable.from(["a"]) }),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(calls).toHaveLength(1);
  });

  it.each([408, 425, 429, 500, 502, 503, 504])("retries status %i", async (status) => {
    await testCase("NB-1113", "retryable statuses: 408, 425, 429 and 5xx except 501 and 505");
    const { dispatcher, calls } = scripted([reply(status), reply(200)]);
    expect((await client(dispatcher).request({ path: "/x", method: "GET" })).statusCode).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it.each([501, 505])("does not retry status %i", async (status) => {
    await testCase("NB-1113", "retryable statuses: 408, 425, 429 and 5xx except 501 and 505");
    const { dispatcher, calls } = scripted([reply(status), reply(200)]);
    await expect(client(dispatcher).request({ path: "/x", method: "GET" })).rejects.toMatchObject({
      errorType: "server_error",
      statusCode: status,
    });
    expect(calls).toHaveLength(1);
  });
});

describe("ResilientClient — Retry-After", () => {
  it("waits at least Retry-After before the next attempt", async () => {
    await testCase("NB-1114", "Retry-After is honoured when it fits retry.maxTimeout");
    const { dispatcher, calls } = scripted([reply(429, { "retry-after": "1" }), reply(200)]);
    const c = client(dispatcher, { retry: { minTimeout: 0, maxTimeout: 2_000, maxRetries: 1 } });
    const started = Date.now();
    expect((await c.request({ path: "/x", method: "GET" })).statusCode).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(990);
    expect(calls).toHaveLength(2);
  });

  it("gives up when Retry-After is longer than retry.maxTimeout, and reports it", async () => {
    await testCase("NB-1115", "a Retry-After beyond the cap ends the call with retryAfterMs");
    const { dispatcher, calls } = scripted([reply(503, { "retry-after": "30" }), reply(200)]);
    const c = client(dispatcher, { retry: { minTimeout: 0, maxTimeout: 200, maxRetries: 2 } });
    await expect(c.request({ path: "/x", method: "GET" })).rejects.toMatchObject({
      statusCode: 503,
      retryAfterMs: 30_000,
    });
    expect(calls).toHaveLength(1);
  });

  it("does not start a retry that cannot finish inside the caller's budget", async () => {
    await testCase("NB-1116", "no retry when the delay exceeds the remaining budget");
    const { dispatcher, calls } = scripted([reply(503, { "retry-after": "1" }), reply(200)]);
    const c = client(dispatcher, {
      retry: { minTimeout: 0, maxTimeout: 5_000, maxRetries: 2 },
      getRemainingMs: () => 500,
    });
    await expect(c.request({ path: "/x", method: "GET" })).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(calls).toHaveLength(1);
  });
});

describe("ResilientClient — attempt timeout", () => {
  it("cancels an attempt after attemptTimeoutMs and retries it", async () => {
    await testCase("NB-1117", "each attempt has its own timeout");
    const { dispatcher, calls } = scripted([{ hangMs: 5_000 }, reply(200)]);
    const c = client(dispatcher, { attemptTimeoutMs: 30 });
    const started = Date.now();
    expect((await c.request({ path: "/slow", method: "GET" })).statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(calls).toHaveLength(2);
  });

  it("reports timeout (transient) when every attempt times out", async () => {
    await testCase("NB-1117", "each attempt has its own timeout");
    const { dispatcher, calls } = scripted([{ hangMs: 5_000 }]);
    const c = client(dispatcher, {
      attemptTimeoutMs: 20,
      retry: { minTimeout: 0, maxTimeout: 0, maxRetries: 1 },
    });
    await expect(c.request({ path: "/slow", method: "GET" })).rejects.toMatchObject({
      errorType: "timeout",
      kind: "transient",
    });
    expect(calls).toHaveLength(2);
  });

  it("reports canceled, without a retry, when the caller aborts", async () => {
    await testCase("NB-1118", "the caller's abort ends the call and is not the dependency's fault");
    const { dispatcher, calls } = scripted([{ hangMs: 5_000 }]);
    const c = client(dispatcher, { circuitBreaker: { volumeThreshold: 1 } });
    const abort = new AbortController();
    const pending = c.request({ path: "/slow", method: "GET", signal: abort.signal });
    setTimeout(() => {
      abort.abort();
    }, 10);
    await expect(pending).rejects.toMatchObject({ errorType: "canceled", kind: "fatal" });
    expect(calls).toHaveLength(1);
    expect(c.breakerState).toBe("closed");
  });
});

describe("ResilientClient — retry budget", () => {
  it("stops retrying once the budget of the window is spent", async () => {
    await testCase("NB-1119", "retries are capped at minRetries + ratio × requests per window");
    const { dispatcher, calls } = scripted([reply(503)]);
    const c = client(dispatcher, {
      retry: {
        minTimeout: 0,
        maxTimeout: 0,
        maxRetries: 2,
        budget: { ratio: 0, minRetries: 3, windowMs: 60_000 },
      },
    });
    for (let i = 0; i < 4; i++) {
      await expect(c.request({ path: "/x", method: "GET" })).rejects.toMatchObject({
        statusCode: 503,
      });
    }
    // 4 first attempts + the 3 retries the budget allows.
    expect(calls).toHaveLength(7);
    expect(c.retries).toBe(3);
    expect(c.retryBudgetExhausted).toBe(3);
  });
});

describe("ResilientClient — what the breaker counts", () => {
  const trip: ResilientClientConfig = {
    circuitBreaker: { volumeThreshold: 1, errorThresholdPercentage: 1, resetTimeout: 60_000 },
    retry: { maxRetries: 0 },
  };

  it("a 4xx is the caller's mistake: the breaker stays closed", async () => {
    await testCase("NB-1120", "4xx, a spent budget and a caller abort do not open the breaker");
    const { dispatcher } = scripted([reply(404)]);
    const c = client(dispatcher, trip);
    for (let i = 0; i < 5; i++) {
      await expect(c.request({ path: "/x", method: "GET" })).rejects.toMatchObject({
        errorType: "client_error",
      });
    }
    expect(c.breakerState).toBe("closed");
  });

  it("a budget that is already spent says nothing about the dependency", async () => {
    await testCase("NB-1120", "4xx, a spent budget and a caller abort do not open the breaker");
    const { dispatcher } = scripted([reply(200)]);
    const c = client(dispatcher, { ...trip, getRemainingMs: () => 0 });
    for (let i = 0; i < 5; i++) {
      await expect(c.request({ path: "/x", method: "GET" })).rejects.toMatchObject({
        errorType: "deadline_exceeded",
      });
    }
    expect(c.breakerState).toBe("closed");
  });

  it("a 5xx opens it, and the next call fails fast as circuit_open", async () => {
    await testCase(
      "NB-1121",
      "failures of the dependency open the breaker; transitions are counted",
    );
    const { dispatcher, calls } = scripted([reply(503)]);
    const c = client(dispatcher, trip);
    await expect(c.request({ path: "/x", method: "GET" })).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(c.breakerState).toBe("open");
    await expect(c.request({ path: "/x", method: "GET" })).rejects.toMatchObject({
      errorType: "circuit_open",
    });
    expect(calls).toHaveLength(1);
    expect(c.breakerTransitions).toEqual([{ from: "closed", to: "open", count: 1 }]);
  });

  it("a second call during the half-open probe is circuit_open, not a network error", async () => {
    await testCase("NB-1122", "a call rejected in half-open is reported as circuit_open");
    const { dispatcher } = scripted([reply(503), { hangMs: 200 }]);
    const c = client(dispatcher, {
      ...trip,
      circuitBreaker: { volumeThreshold: 1, errorThresholdPercentage: 1, resetTimeout: 20 },
    });
    await expect(c.request({ path: "/x", method: "GET" })).rejects.toBeDefined();
    await new Promise((r) => setTimeout(r, 40));
    const probe = c.request({ path: "/x", method: "GET" });
    await expect(c.request({ path: "/x", method: "GET" })).rejects.toMatchObject({
      errorType: "circuit_open",
    });
    expect((await probe).statusCode).toBe(200);
    expect(c.breakerState).toBe("closed");
  });
});

describe("ResilientClient — a connection that cannot be made", () => {
  it("the attempt timeout and the caller's budget end a call stuck in the TLS handshake", async () => {
    await testCase("NB-1325", "the attempt timeout covers making the connection");
    // Accepts the TCP connection and never says a word: a TLS handshake that hangs.
    const accepted: Socket[] = [];
    const silent = createServer((socket) => {
      accepted.push(socket);
    });
    await new Promise<void>((resolve) => {
      silent.listen(0, "127.0.0.1", resolve);
    });
    const base = `https://127.0.0.1:${(silent.address() as AddressInfo).port}`;
    const made: ResilientClient[] = [];
    try {
      // undici alone waits out its 10 s connect timeout whatever the signal says.
      const bounded = new ResilientClient(base, {
        attemptTimeoutMs: 300,
        retry: { maxRetries: 0 },
      });
      made.push(bounded);
      const started = performance.now();
      await expect(bounded.request({ path: "/", method: "GET" })).rejects.toMatchObject({
        errorType: "timeout",
      });
      expect(performance.now() - started).toBeLessThan(1000);

      // The caller's budget is shorter than the attempt timeout: it ends the wait.
      const budgeted = new ResilientClient(base, {
        attemptTimeoutMs: 1000,
        retry: { maxRetries: 0 },
        getRemainingMs: () => 250,
      });
      made.push(budgeted);
      const again = performance.now();
      await expect(budgeted.request({ path: "/", method: "GET" })).rejects.toMatchObject({
        errorType: "deadline_exceeded",
      });
      expect(performance.now() - again).toBeLessThan(800);
    } finally {
      // The abandoned connection attempts end when the peer goes away.
      for (const socket of accepted) socket.destroy();
      silent.close();
      await Promise.all(made.map((opened) => opened.close().catch(() => {})));
    }
  }, 20_000);
});
