import { describe, expect, it } from "vitest";

import { AppLogger } from "@base/logger";
import { captureLogs, meta, testCase } from "@base/testing";

import { OtelShutdownService } from "./otel-shutdown.service.js";
import type { TelemetryHandle } from "./setup-telemetry.tokens.js";

/** A provider whose flush resolves or rejects, recording what was called. */
function provider(flush: "ok" | "fail"): { calls: string[]; p: object } {
  const calls: string[] = [];
  return {
    calls,
    p: {
      forceFlush: () => {
        calls.push("flush");
        return flush === "ok" ? Promise.resolve() : Promise.reject(new Error("export failed"));
      },
      shutdown: () => {
        calls.push("shutdown");
        return Promise.resolve();
      },
    },
  };
}

describe("OtelShutdownService", () => {
  meta({
    epic: "nodejs-basics",
    feature: "observability",
    owner: "@team-platform",
    tags: ["observability", "unit"],
  });

  it("shuts every provider down, even when its flush fails, and reports the failure", async () => {
    await testCase("NB-431", "collector unreachable at shutdown → providers still closed");
    const logs = captureLogs();
    const tracer = provider("fail");
    const meter = provider("ok");
    const handle = {
      tracerProvider: tracer.p,
      meterProvider: meter.p,
      stopPyroscope: () => Promise.resolve(),
    } as unknown as TelemetryHandle;

    await new OtelShutdownService(handle, new AppLogger(logs.logger)).onApplicationShutdown(
      "SIGTERM",
    );

    expect(tracer.calls).toEqual(["flush", "shutdown"]);
    expect(meter.calls).toEqual(["flush", "shutdown"]);
    expect(logs.find((r) => r["msg"] === "Telemetry shutdown error")).toBeDefined();
    expect(logs.find((r) => r["msg"] === "Telemetry shutdown complete")).toBeDefined();
  });
});
