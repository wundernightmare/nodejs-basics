import { MockAgent, type MockPool } from "undici";
import { afterEach, describe, expect, it } from "vitest";

import { meta, testCase } from "@base/testing";

import { ResilientClient } from "./resilient-client.js";
import { resilientFetch } from "./resilient-fetch.js";

const BASE = "http://tasks.test";

describe("resilientFetch", () => {
  meta({
    epic: "nodejs-basics",
    feature: "resilient-client",
    owner: "@team-platform",
    tags: ["http", "client", "unit"],
  });

  let agent: MockAgent;
  afterEach(async () => {
    await agent.close();
  });

  function client(pool: MockPool): ResilientClient {
    return new ResilientClient(BASE, {
      passthrough4xx: true,
      getRequestId: () => "req-7",
      getRemainingMs: () => 2_000,
      _dispatcher: pool,
    });
  }

  it("sends a fetch Request through the client, with the request id and the budget", async () => {
    await testCase(
      "NB-731",
      "method, path + query, body and headers arrive; propagation headers added",
    );
    agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(BASE) as MockPool;
    let seen: { path?: string; body?: string; headers?: Record<string, string> } = {};
    pool.intercept({ path: (p) => p.startsWith("/tasks"), method: "POST" }).reply((opts) => {
      seen = {
        path: opts.path,
        body: Buffer.from(opts.body as Uint8Array).toString(),
        headers: opts.headers as Record<string, string>,
      };
      return {
        statusCode: 201,
        data: { id: "x" },
        responseOptions: { headers: { "content-type": "application/json", "x-a": "1" } },
      };
    });

    const res = await resilientFetch(client(pool))(`${BASE}/tasks?limit=5`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "hi" }),
    });

    expect(res.status).toBe(201);
    expect(res.headers.get("x-a")).toBe("1");
    expect(await res.json()).toEqual({ id: "x" });
    expect(seen.path).toBe("/tasks?limit=5");
    expect(seen.body).toBe('{"title":"hi"}');
    expect(seen.headers?.["content-type"]).toBe("application/json");
    expect(seen.headers?.["x-request-id"]).toBe("req-7");
    expect(Number(seen.headers?.["x-request-timeout-ms"])).toBeLessThanOrEqual(2_000);
  });

  it("hands a 4xx back as a response for the caller to read", async () => {
    await testCase("NB-732", "404 problem → Response, not an OutboundError (passthrough4xx)");
    agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(BASE) as MockPool;
    pool
      .intercept({ path: "/tasks/nope", method: "GET" })
      .reply(404, { status: 404 }, { headers: { "content-type": "application/problem+json" } });

    const res = await resilientFetch(client(pool))(`${BASE}/tasks/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ status: 404 });
  });
});
