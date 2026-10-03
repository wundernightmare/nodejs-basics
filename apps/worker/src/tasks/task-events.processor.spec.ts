import { describe, expect, it } from "vitest";

import type { TaskCreatedEvent } from "@base/contracts";
import type { JobQueue } from "@base/jobs";
import { AppLogger, pinoLogger } from "@base/logger";
import { ReadinessService } from "@base/observability";
import { meta, testCase } from "@base/testing";

import { TaskEventsProcessor } from "./task-events.processor.js";

const appLogger = new AppLogger(pinoLogger.child({}, { level: "silent" }));

describe("TaskEventsProcessor", () => {
  meta({ epic: "nodejs-basics", feature: "worker", owner: "@team-platform", tags: ["worker"] });

  it("is not ready while its job backend does not answer", async () => {
    await testCase("NB-983", "a worker that cannot process jobs is taken out of rotation");
    const readiness = new ReadinessService([], appLogger);
    const queue = {
      ping: () => Promise.reject(new Error("connection refused")),
    } as unknown as JobQueue<TaskCreatedEvent>;
    expect(new TaskEventsProcessor(queue, appLogger, readiness)).toBeInstanceOf(
      TaskEventsProcessor,
    );
    const result = await readiness.check();
    expect(result.status).toBe("not_ready");
    expect(result.checks["jobs"]).toBe("connection refused");
  });
});
