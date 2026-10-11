import { describe, expect, it } from "vitest";

import { AppLogger, pinoLogger } from "@base/logger";
import { testCase } from "@base/testing";

import { type ReadinessCheck, ReadinessService } from "./readiness.service.js";

const appLogger = new AppLogger(pinoLogger.child({}, { level: "silent" }));

function service(checks: ReadinessCheck[]): ReadinessService {
  return new ReadinessService(checks, appLogger);
}

const ok: ReadinessCheck = { name: "db", check: async () => "ok" };
const failing: ReadinessCheck = {
  name: "kafka",
  check: async () => {
    throw new Error("not connected");
  },
};

describe("ReadinessService", () => {
  it("is ok when every check passes", async () => {
    expect(await service([ok]).check()).toEqual({ status: "ok", ok: true, checks: { db: "ok" } });
  });

  it("a failing critical check is not_ready", async () => {
    const result = await service([ok, failing]).check();
    expect(result).toEqual({
      status: "not_ready",
      ok: false,
      checks: { db: "ok", kafka: "not connected" },
    });
  });

  it("a failing optional check is degraded but still ready", async () => {
    const result = await service([ok, { ...failing, optional: true }]).check();
    expect(result.status).toBe("degraded");
    expect(result.ok).toBe(true);
  });

  it("times out a hanging check", async () => {
    const hang: ReadinessCheck = {
      name: "slow",
      check: () => new Promise(() => {}),
      timeoutMs: 20,
    };
    const result = await service([hang]).check();
    expect(result.checks["slow"]).toBe("timeout after 20 ms");
    expect(result.status).toBe("not_ready");
  });

  it("register() adds or replaces a check by name at runtime", async () => {
    const s = service([]);
    s.register(failing);
    expect((await s.check()).status).toBe("not_ready");
    s.register({ ...failing, check: async () => "ok" });
    expect(await s.check()).toEqual({ status: "ok", ok: true, checks: { kafka: "ok" } });
  });

  it("closing the gate (beforeApplicationShutdown) makes it not_ready regardless of checks", async () => {
    const s = service([ok]);
    await s.beforeApplicationShutdown("SIGTERM");
    expect(s.isReady).toBe(false);
    expect((await s.check()).status).toBe("not_ready");
    s.setReady(true);
    expect((await s.check()).status).toBe("ok");
  });

  it("keeps serving for HTTP_SHUTDOWN_DELAY_MS after the gate closes", async () => {
    await testCase("NB-1016", "load balancers see not_ready before the api stops listening");
    const saved = process.env["HTTP_SHUTDOWN_DELAY_MS"];
    process.env["HTTP_SHUTDOWN_DELAY_MS"] = "150";
    try {
      const s = service([ok]);
      const started = performance.now();
      const closing = s.beforeApplicationShutdown("SIGTERM");
      expect((await s.check()).status).toBe("not_ready"); // at once, while the delay runs
      await closing;
      expect(performance.now() - started).toBeGreaterThanOrEqual(140);
    } finally {
      if (saved === undefined) delete process.env["HTTP_SHUTDOWN_DELAY_MS"];
      else process.env["HTTP_SHUTDOWN_DELAY_MS"] = saved;
    }
  });
});
