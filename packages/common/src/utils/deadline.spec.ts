import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { meta, testCase } from "@base/testing";

import { genRequestId, registerRequestContext } from "../http/request-context.hooks.js";
import {
  callBudgetMs,
  DeadlineExceededError,
  parseTimeoutMs,
  remainingMs,
  withDeadline,
} from "./deadline.js";

describe("request deadline", () => {
  meta({
    epic: "nodejs-basics",
    feature: "deadlines",
    owner: "@team-platform",
    tags: ["deadline", "unit"],
  });

  it("gives a call min(own timeout, what is left), and nothing once the budget is spent", async () => {
    await testCase("NB-601", "callBudgetMs caps by the budget; spent → DeadlineExceededError");
    expect(remainingMs()).toBeUndefined();
    expect(callBudgetMs(5_000)).toBe(5_000);
    withDeadline(1_000, () => {
      expect(callBudgetMs(5_000)).toBeLessThanOrEqual(1_000);
      expect(callBudgetMs(100)).toBe(100);
    });
    withDeadline(0, () => {
      expect(() => callBudgetMs(5_000, "postgres")).toThrow(DeadlineExceededError);
    });
  });

  it("never lets a nested budget extend the enclosing one", async () => {
    await testCase("NB-602", "withDeadline nests as min(outer, inner)");
    withDeadline(100, () => {
      withDeadline(60_000, () => {
        expect(remainingMs()).toBeLessThanOrEqual(100);
      });
      withDeadline(10, () => {
        expect(remainingMs()).toBeLessThanOrEqual(10);
      });
    });
  });

  it("parses x-request-timeout-ms as positive integer milliseconds only", async () => {
    await testCase("NB-603", "garbage, zero, negative and huge values are ignored");
    expect(parseTimeoutMs("250")).toBe(250);
    expect(parseTimeoutMs(["250", "9"])).toBe(250);
    for (const bad of [undefined, "", "0", "-5", "1.5", "10s", "9999999999"]) {
      expect(parseTimeoutMs(bad)).toBeUndefined();
    }
  });

  it("starts each request with HTTP_REQUEST_TIMEOUT_MS, shortened (never extended) by the caller", async () => {
    await testCase("NB-604", "inbound budget = min(server budget, x-request-timeout-ms)");
    const app = Fastify({ genReqId: genRequestId, logger: false });
    registerRequestContext(app, { requestTimeoutMs: 5_000 });
    app.get("/", async () => ({ left: remainingMs() }));
    await app.ready();
    try {
      const left = async (headers: Record<string, string> = {}): Promise<number> =>
        (await app.inject({ url: "/", headers })).json<{ left: number }>().left;
      expect(await left()).toBeGreaterThan(4_000);
      expect(await left()).toBeLessThanOrEqual(5_000);
      expect(await left({ "x-request-timeout-ms": "300" })).toBeLessThanOrEqual(300);
      expect(await left({ "x-request-timeout-ms": "600000" })).toBeLessThanOrEqual(5_000);
    } finally {
      await app.close();
    }
  });
});
