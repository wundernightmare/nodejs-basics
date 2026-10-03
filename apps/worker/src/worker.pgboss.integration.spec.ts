import type { INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TaskCreatedEvent } from "@base/contracts";
import { type JobQueue, jobQueueToken } from "@base/jobs";
import { ReadinessService } from "@base/observability";
import { integration, meta, testCase } from "@base/testing";

import { TASK_JOBS } from "./tasks/task-events.consumer.js";

/**
 * The worker without VALKEY_URL: its jobs run on pg-boss in Postgres. The
 * module tree the process builds, not the adapter alone.
 */
const infra = integration("postgres", "kafka");

describe.skipIf(infra.skip)("apps/worker on Kafka + Postgres (integration)", () => {
  meta({
    epic: "nodejs-basics",
    feature: "jobs",
    owner: "@team-platform",
    tags: ["worker", "integration"],
  });

  let app: INestApplicationContext;

  beforeAll(async () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("VALKEY_")) Reflect.deleteProperty(process.env, key);
    }
    process.env["APP_CONFIG_FILE"] = "absent.yaml";
    process.env["ADMIN_PORT"] = "0";
    process.env["LOG_LEVEL"] ??= "warn";
    await import("./instrumentation.js");
    const { WorkerModule } = await import("./worker.module.js");
    app = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    app.enableShutdownHooks();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("is ready on pg-boss and works off a job", async () => {
    await testCase("NB-1013", "no Valkey: the worker's jobs run on pg-boss in Postgres");
    const checks = (await app.get(ReadinessService).check()).checks;
    expect(checks["jobs"]).toBe("ok");

    const queue = app.get<JobQueue<TaskCreatedEvent>>(jobQueueToken(TASK_JOBS));
    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 21);
    await queue.send(
      { type: "task.created", id, title: "t", createdAt: new Date().toISOString() },
      id,
    );
    await expect.poll(() => queue.waiting(), { timeout: 10_000 }).toBe(0);
  });
});
