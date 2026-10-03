import { describe, expect, it } from "vitest";

import { type BullMQMetricsService } from "@base/jobs";
import { AppLogger, pinoLogger } from "@base/logger";
import { ReadinessService } from "@base/observability";
import { meta, testCase } from "@base/testing";

import { TaskEventsProcessor } from "./task-events.processor.js";

const appLogger = new AppLogger(pinoLogger.child({}, { level: "silent" }));

describe("TaskEventsProcessor", () => {
  meta({ epic: "nodejs-basics", feature: "worker", owner: "@team-platform", tags: ["worker"] });

  it("is not ready until its BullMQ worker has started", async () => {
    await testCase("NB-983", "a worker that cannot process jobs is taken out of rotation");
    const readiness = new ReadinessService([], appLogger);
    // Constructed but never bootstrapped: no BullMQ worker yet.
    const processor = new TaskEventsProcessor({}, {} as BullMQMetricsService, appLogger, readiness);
    expect(processor).toBeInstanceOf(TaskEventsProcessor);
    const result = await readiness.check();
    expect(result.status).toBe("not_ready");
    expect(result.checks["valkey"]).toBe("worker not started");
  });
});
