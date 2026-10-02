import { MockAgent } from "undici";
import type { MockPool } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ResilientClient } from "./resilient-client.js";

const BASE = "http://adaptive.test";

describe("ResilientClient — adaptive concurrency", () => {
  let agent: MockAgent;
  let pool: MockPool;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    pool = agent.get(BASE) as MockPool;
  });
  afterEach(async () => {
    await agent.close();
  });

  const client = (initialLimit: number): ResilientClient =>
    new ResilientClient(BASE, {
      retry: { minTimeout: 0, maxTimeout: 0, maxRetries: 0 },
      adaptiveConcurrency: { enabled: true, initialLimit, minLimit: 1, maxLimit: 50 },
      _dispatcher: pool,
    });

  it("queues a request above the limit and lets it through when a slot frees", async () => {
    const c = client(1);
    pool.intercept({ path: "/a", method: "GET" }).reply(200, "a").delay(30);
    pool.intercept({ path: "/b", method: "GET" }).reply(200, "b");
    const [a, b] = await Promise.all([
      c.request({ path: "/a", method: "GET" }),
      c.request({ path: "/b", method: "GET" }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
  });

  it("lowers the limit when a response is far slower than the best seen", async () => {
    // Large enough for ceil(limit × 0.9) to actually move.
    const c = client(20);
    pool.intercept({ path: "/fast", method: "GET" }).reply(200, "ok");
    await c.request({ path: "/fast", method: "GET" });
    const raised = c.adaptiveLimit ?? 0;
    pool.intercept({ path: "/slow", method: "GET" }).reply(200, "ok").delay(80);
    await c.request({ path: "/slow", method: "GET" });
    expect(c.adaptiveLimit).toBeLessThan(raised);
  });
});
