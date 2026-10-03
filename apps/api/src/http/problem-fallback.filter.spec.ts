import type { ArgumentsHost } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { PROBLEM_CONTENT_TYPE } from "@base/common";
import { meta, testCase } from "@base/testing";

import { ProblemFallbackFilter } from "./problem-fallback.filter.js";

describe("ProblemFallbackFilter", () => {
  meta({ epic: "nodejs-basics", feature: "errors", owner: "@team-platform", tags: ["api"] });

  it("answers an unplanned error with a 500 problem that carries an errorId, never the message", async () => {
    await testCase("NB-974", "the last-resort 500 is still RFC 9457, without leaking internals");
    const sent: { status?: number; headers: Record<string, string>; body?: unknown } = {
      headers: {},
    };
    const reply = {
      status(code: number) {
        sent.status = code;
        return this;
      },
      header(name: string, value: string) {
        sent.headers[name] = value;
        return this;
      },
      send(body: unknown) {
        sent.body = body;
        return Promise.resolve();
      },
    };
    const request = { url: "/tasks/1", routeOptions: { url: "/tasks/:id" } };
    const host = {
      switchToHttp: () => ({ getResponse: () => reply, getRequest: () => request }),
    } as unknown as ArgumentsHost;

    new ProblemFallbackFilter().catch("password=hunter2 in a driver error", host);

    expect(sent.status).toBe(500);
    expect(sent.headers["Content-Type"]).toBe(PROBLEM_CONTENT_TYPE);
    expect(sent.body).toMatchObject({ status: 500, instance: "/tasks/1" });
    expect((sent.body as { errorId?: unknown }).errorId).toEqual(expect.any(String));
    expect(JSON.stringify(sent.body)).not.toContain("hunter2");
  });
});
