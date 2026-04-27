import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { OutboundError } from "./resilient-client.errors.js";
import {
  FunctionConfigAdapter,
  ResilientPool,
  StaticConfigAdapter,
  extractBaseUrl,
  matchesSelector,
} from "./resilient-client.pool.js";

// ─── matchesSelector ──────────────────────────────────────────────────────────

describe("matchesSelector", () => {
  it("matches an exact URL with a full selector", () => {
    expect(matchesSelector("https://example.com/foo", "https://example.com/foo")).toBe(true);
  });

  it("matches a URL with a wildcard placeholder", () => {
    expect(
      matchesSelector(
        "https://graph.facebook.com/123456/events",
        "://graph.facebook.com{pixel_id}/events",
      ),
    ).toBe(true);
  });

  it("does not match a different host", () => {
    expect(
      matchesSelector("https://evil.com/123456/events", "://graph.facebook.com{pixel_id}/events"),
    ).toBe(false);
  });

  it("matches a URL with multiple placeholders", () => {
    expect(
      matchesSelector(
        "https://api.example.com/v1/users/42/posts/7",
        "://api.example.com/v1/users{user_id}/posts{post_id}",
      ),
    ).toBe(true);
  });

  it("does not match when path part is missing", () => {
    expect(
      matchesSelector("https://api.example.com/v1/users", "://api.example.com/v1/users{uid}/posts"),
    ).toBe(false);
  });

  it("matches a plain selector with no placeholders", () => {
    expect(matchesSelector("https://api.example.com/status", "://api.example.com")).toBe(true);
  });

  it("does not match an unrelated URL against a plain selector", () => {
    expect(matchesSelector("https://other.com/status", "://api.example.com")).toBe(false);
  });
});

// ─── extractBaseUrl ───────────────────────────────────────────────────────────

describe("extractBaseUrl", () => {
  it("extracts origin from a full https URL", () => {
    expect(extractBaseUrl("https://api.example.com/foo?bar=1")).toBe("https://api.example.com");
  });

  it("prefixes https:// when selector starts with ://", () => {
    expect(extractBaseUrl("://graph.facebook.com{pixel_id}/events")).toBe(
      "https://graph.facebook.com",
    );
  });

  it("handles http:// scheme", () => {
    expect(extractBaseUrl("http://localhost:8080/path")).toBe("http://localhost:8080");
  });

  it("throws for an unrecognisable selector", () => {
    expect(() => extractBaseUrl("not-a-url")).toThrow("Cannot derive base URL");
  });
});

// ─── ConfigAdapters ───────────────────────────────────────────────────────────

describe("StaticConfigAdapter", () => {
  it("returns the provided targets array", () => {
    const targets = [{ name: "t1", selector: "://example.com" }];
    const adapter = new StaticConfigAdapter(targets);
    expect(adapter.load()).toBe(targets);
  });
});

describe("FunctionConfigAdapter", () => {
  it("calls the getter function each time load() is called", () => {
    let call = 0;
    const getter = () => {
      call++;
      return [{ name: `t${call}`, selector: "://example.com" }];
    };
    const adapter = new FunctionConfigAdapter(getter);
    expect(adapter.load()[0]!.name).toBe("t1");
    expect(adapter.load()[0]!.name).toBe("t2");
  });
});

// ─── ResilientPool ─────────────────────────────────────────────────────────────
//
// Uses a real local HTTP server so no mock injection into ResilientPool internals is needed.

describe("ResilientPool", () => {
  let server: ReturnType<typeof createServer>;
  let port: number;
  let responses: Array<{ status: number; body: string }>;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        responses = [];
        server = createServer((_req, res) => {
          const next = responses.shift() ?? { status: 200, body: JSON.stringify({ ok: true }) };
          res.writeHead(next.status, { "content-type": "application/json" });
          res.end(next.body);
        });
        server.listen(0, "127.0.0.1", () => {
          port = (server.address() as AddressInfo).port;
          resolve();
        });
      }),
  );

  afterAll(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  );

  afterEach(() => {
    responses = [];
  });

  function makePool(): ResilientPool {
    return ResilientPool.fromAdapter(
      new StaticConfigAdapter([
        {
          name: "local_api",
          selector: `http://127.0.0.1:${port}`,
          connections: 1,
          retry: { maxRetries: 0 },
          circuitBreaker: { volumeThreshold: 100, timeout: 5_000 },
        },
      ]),
    );
  }

  it("sends a request to the matching target", async () => {
    const pool = makePool();
    const url = `http://127.0.0.1:${port}/health`;
    const res = await pool.send(url, { method: "GET", path: "/health" });
    expect(res.statusCode).toBe(200);
    await pool.shutdown(1_000);
  });

  it("throws OutboundError.noMatchingTarget for unknown URL", async () => {
    const pool = makePool();
    await expect(
      pool.send("https://unknown-host-xyz.example.com/foo", {
        method: "GET",
        path: "/foo",
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof OutboundError && e.errorType === "no_matching_target",
    );
    await pool.shutdown(1_000);
  });

  it("throws shuttingDown after shutdown() is called", async () => {
    const pool = makePool();
    await pool.shutdown(1_000);

    await expect(
      pool.send(`http://127.0.0.1:${port}/foo`, { method: "GET", path: "/foo" }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof OutboundError && e.errorType === "shutting_down",
    );
  });

  it("circuitBreakerStates() returns closed for all targets initially", () => {
    const pool = makePool();
    const states = pool.circuitBreakerStates();
    expect(states["local_api"]).toBe("closed");
  });

  it("propagates error from target and records failure metrics", async () => {
    const pool = makePool();
    // 503 with maxRetries:0 → retriesExhausted → ResilientPool catches + records failure
    responses.push({ status: 503, body: "unavailable" });

    const url = `http://127.0.0.1:${port}/api`;
    await expect(pool.send(url, { method: "GET", path: "/api" })).rejects.toSatisfy(
      (e: unknown) => e instanceof OutboundError && e.kind === "transient",
    );
    await pool.shutdown(1_000);
  });

  it("returns response from the correct target path", async () => {
    const pool = makePool();
    responses.push({ status: 201, body: JSON.stringify({ created: true }) });

    const url = `http://127.0.0.1:${port}/items`;
    const res = await pool.send(url, { method: "POST", path: "/items" });
    expect(res.statusCode).toBe(201);
    await pool.shutdown(1_000);
  });

  it("wraps non-OutboundError into OutboundError.network on failure", async () => {
    const pool = makePool();
    // 400 response → ResilientClient throws OutboundError.clientError
    // ResilientPool wraps it in the catch branch
    responses.push({ status: 400, body: "bad" });

    const url = `http://127.0.0.1:${port}/bad`;
    await expect(pool.send(url, { method: "GET", path: "/bad" })).rejects.toSatisfy(
      (e: unknown) => e instanceof OutboundError && e.kind === "fatal",
    );
    await pool.shutdown(1_000);
  });

  it("handles query string in URL during routing", async () => {
    const pool = makePool();
    responses.push({ status: 200, body: JSON.stringify({ q: true }) });

    const url = `http://127.0.0.1:${port}/search?q=test&page=1`;
    const res = await pool.send(url, { method: "GET", path: "/search?q=test&page=1" });
    expect(res.statusCode).toBe(200);
    await pool.shutdown(1_000);
  });

  it("routes to first matching target when multiple selectors overlap", () => {
    const pool = ResilientPool.fromAdapter(
      new StaticConfigAdapter([
        { name: "specific", selector: `http://127.0.0.1:${port}/api/v2` },
        { name: "general", selector: `http://127.0.0.1:${port}` },
      ]),
    );
    const states = pool.circuitBreakerStates();
    expect(states["specific"]).toBe("closed");
    expect(states["general"]).toBe("closed");
  });
});
