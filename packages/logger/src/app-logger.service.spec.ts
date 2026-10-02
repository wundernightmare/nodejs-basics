import { describe, expect, it } from "vitest";

import { captureLogs, meta, testCase } from "@base/testing";

import { AppLogger } from "./app-logger.service.js";

describe("AppLogger.error", () => {
  meta({ epic: "nodejs-basics", feature: "logging", owner: "@team-platform", tags: ["logger"] });

  it("maps Nest's (message, stack, context) signature onto ECS error fields", async () => {
    await testCase("NB-909", "Nest internal errors keep their stack trace");
    const logs = captureLogs({ messageKey: "message" });
    const stack = "Error: boom\n    at Foo.bar (foo.ts:1:1)";
    new AppLogger(logs.logger).error("boom", stack, "ExceptionsHandler");
    expect(logs.lines()[0]).toMatchObject({
      "log.logger": "ExceptionsHandler",
      "error.message": "boom",
      "error.stack_trace": stack,
    });
  });
});
