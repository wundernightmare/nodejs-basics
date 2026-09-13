import { Writable } from "node:stream";

import pino from "pino";
import { describe, expect, it } from "vitest";

import { withDebugLogging, withRequestId } from "@base/common";

import { LogLevel } from "./log-level.js";
import { buildPinoOptions } from "./pino.config.js";

interface Line {
  "log.level": string;
  message: string;
  "http.request.id"?: string;
}

/** A pino logger writing JSON lines into an array, with the shared option set. */
function sinkLogger(level: LogLevel): { logger: pino.Logger; lines: Line[] } {
  const lines: Line[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      for (const raw of chunk.toString().split("\n")) {
        if (raw.trim() !== "") lines.push(JSON.parse(raw) as Line);
      }
      cb();
    },
  });
  return { logger: pino(buildPinoOptions(level), sink), lines };
}

describe("pino logMethod hook", () => {
  it("enforces the runtime LogLevel, not pino's pinned level", () => {
    const level = new LogLevel("info");
    const { logger, lines } = sinkLogger(level);
    logger.debug("hidden");
    logger.info("shown");
    level.set("debug", 0);
    logger.debug("now shown");
    expect(lines.map((l) => l.message)).toEqual(["shown", "now shown"]);
  });

  it("lets everything through under withDebugLogging(), on children too", () => {
    const level = new LogLevel("warn");
    const { logger, lines } = sinkLogger(level);
    const child = logger.child({ "log.logger": "Child" });
    child.debug("hidden");
    withDebugLogging(() => {
      child.trace("trace passes");
      logger.debug("debug passes");
    });
    child.debug("hidden again");
    expect(lines.map((l) => `${l["log.level"]}:${l.message}`)).toEqual([
      "trace:trace passes",
      "debug:debug passes",
    ]);
  });

  it("stamps http.request.id from the request context via the mixin", () => {
    const { logger, lines } = sinkLogger(new LogLevel("info"));
    withRequestId("REQ42", () => {
      logger.info("in request");
    });
    logger.info("outside");
    expect(lines[0]?.["http.request.id"]).toBe("REQ42");
    expect(lines[1]?.["http.request.id"]).toBeUndefined();
  });
});
