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

describe("AppLogger — NestJS LoggerService", () => {
  meta({ epic: "nodejs-basics", feature: "logging", owner: "@team-platform", tags: ["logger"] });

  it("maps each Nest level onto its pino level, with the context as log.logger", async () => {
    await testCase("NB-1339", "AppLogger: Nest levels map onto pino levels");
    const logs = captureLogs({ messageKey: "message" });
    const logger = new AppLogger(logs.logger);
    logger.verbose("v", "Ctx");
    logger.debug("d", "Ctx");
    logger.log("l", "Ctx");
    logger.warn("w", "Ctx");
    logger.fatal("f", "Ctx");
    // pino's numeric levels: trace 10, debug 20, info 30, warn 40, fatal 60.
    expect(
      logs.lines().map((line) => [line["level"], line["message"], line["log.logger"]]),
    ).toEqual([
      [10, "v", "Ctx"],
      [20, "d", "Ctx"],
      [30, "l", "Ctx"],
      [40, "w", "Ctx"],
      [60, "f", "Ctx"],
    ]);
  });

  it("error(): an Error spreads into ECS fields; a second string is the context", async () => {
    await testCase("NB-1340", "AppLogger: the three signatures of error()");
    const logs = captureLogs({ messageKey: "message" });
    const logger = new AppLogger(logs.logger);
    logger.error("failed", new TypeError("bad input"), "Handler");
    logger.error("plain", "Bootstrap");
    expect(logs.lines()[0]).toMatchObject({
      message: "failed",
      "log.logger": "Handler",
      "error.type": "TypeError",
      "error.message": "bad input",
    });
    expect(logs.lines()[1]).toMatchObject({ message: "plain", "log.logger": "Bootstrap" });
    expect(logs.lines()[1]).not.toHaveProperty("error.stack_trace");
  });

  it("a message that is not a string is still a message", async () => {
    await testCase("NB-1341", "AppLogger: non-string messages");
    const logs = captureLogs({ messageKey: "message" });
    const logger = new AppLogger(logs.logger);
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    logger.log({ a: 1 });
    logger.log(new Error("as a message"));
    logger.log(cyclic); // cannot be JSON: its String() form
    expect(logs.lines().map((line) => line["message"])).toEqual([
      '{"a":1}',
      "as a message",
      "[object Object]",
    ]);
  });
});
