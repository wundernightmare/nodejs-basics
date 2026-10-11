import { ConfigService } from "@nestjs/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskCreatedEvent } from "@base/contracts";
import type { JobQueue } from "@base/jobs";
import { KafkaBackpressureError, KafkaPermanentError } from "@base/kafka";
import { AppLogger, pinoLogger } from "@base/logger";
import { ReadinessService } from "@base/observability";
import { meta, testCase } from "@base/testing";

import {
  JobQueueFullError,
  JobQueueUnavailableError,
  TaskEventsConsumer,
} from "./task-events.consumer.js";

const appLogger = new AppLogger(pinoLogger.child({}, { level: "silent" }));

function harness(env: Record<string, string> = {}): {
  consumer: TaskEventsConsumer;
  add: ReturnType<typeof vi.fn>;
  waiting: ReturnType<typeof vi.fn>;
  readiness: ReadinessService;
} {
  const add = vi.fn(() => Promise.resolve());
  const waiting = vi.fn(() => Promise.resolve(0));
  const queue = {
    name: "task-events",
    send: add,
    waiting,
  } as unknown as JobQueue<TaskCreatedEvent>;
  const readiness = new ReadinessService([], appLogger);
  const consumer = new TaskEventsConsumer(new ConfigService(env), queue, appLogger, readiness);
  return { consumer, add, waiting, readiness };
}

const event = (s: string): Buffer => Buffer.from(s);
const TASK_ID = "V1StGXR8_Z5jdHi6B-myT";
const created = JSON.stringify({
  type: "task.created",
  id: TASK_ID,
  title: "t",
  createdAt: "2026-01-01T00:00:00Z",
});

describe("TaskEventsConsumer.handle", () => {
  meta({ epic: "nodejs-basics", feature: "worker", owner: "@team-platform", tags: ["worker"] });
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is not ready until its Kafka consumer runs", async () => {
    await testCase("NB-975", "a worker that cannot consume is taken out of rotation");
    vi.useRealTimers();
    const result = await harness().readiness.check();
    expect(result.status).toBe("not_ready");
    expect(result.checks["kafka"]).toBe("consumer not running");
  });

  it("enqueues a task.created event as a job keyed by the task id", async () => {
    await testCase("NB-943", "task.created → BullMQ job");
    const h = harness();
    await h.consumer.handle(event(created));
    expect(h.add).toHaveBeenCalledOnce();
    expect(h.add.mock.calls[0]?.[1]).toBe(TASK_ID);
  });

  it("dead-letters a task.created that breaks the contract instead of enqueuing it", async () => {
    await testCase("NB-1008", "an event without a valid id never becomes a job with a random id");
    const h = harness();
    const broken = { type: "task.created", title: "t", createdAt: "2026-01-01T00:00:00Z" };
    for (const value of [broken, { ...broken, id: "not-a-nanoid" }]) {
      await expect(h.consumer.handle(event(JSON.stringify(value)))).rejects.toBeInstanceOf(
        KafkaPermanentError,
      );
    }
    await expect(h.consumer.handle(event("not json"))).rejects.toThrow("undecodable");
    expect(h.add).not.toHaveBeenCalled();
  });

  it("returns (so the runner commits and skips) for an event type that is not ours", async () => {
    await testCase("NB-901", "kafka consumer skips other event types");
    const h = harness();
    for (const value of ["null", "42", JSON.stringify({ type: "task.deleted" })]) {
      await h.consumer.handle(event(value));
    }
    await h.consumer.handle(null);
    expect(h.add).not.toHaveBeenCalled();
  });

  it("a job queue that is down is back-pressure, not a bad event", async () => {
    await testCase("NB-1022", "a Valkey / Postgres blip never dead-letters good events");
    const h = harness();
    h.waiting.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(h.consumer.handle(event(created))).rejects.toBeInstanceOf(
      JobQueueUnavailableError,
    );
    h.add.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const err = await h.consumer.handle(event(created)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KafkaBackpressureError);
    expect((err as Error).cause).toEqual(new Error("ECONNREFUSED"));
  });

  it("pushes back while the job queue is full — read at most once a second", async () => {
    await testCase("NB-941", "a full job queue pushes back on Kafka");
    const h = harness({ WORKER_QUEUE_MAX_WAITING: "100" });
    h.waiting.mockResolvedValue(100);
    await expect(h.consumer.handle(event(created))).rejects.toBeInstanceOf(JobQueueFullError);
    await expect(h.consumer.handle(event(created))).rejects.toBeInstanceOf(KafkaBackpressureError);
    expect(h.waiting).toHaveBeenCalledOnce();
    expect(h.add).not.toHaveBeenCalled();
    h.waiting.mockResolvedValue(99);
    vi.advanceTimersByTime(1_001);
    await h.consumer.handle(event(created));
    expect(h.add).toHaveBeenCalledOnce();
  });

  it("a burst inside one cache window cannot overshoot the limit", async () => {
    await testCase("NB-942", "job queue limit holds under a burst");
    const h = harness({ WORKER_QUEUE_MAX_WAITING: "2" });
    await h.consumer.handle(event(created));
    await h.consumer.handle(event(created));
    await expect(h.consumer.handle(event(created))).rejects.toBeInstanceOf(JobQueueFullError);
    expect(h.add).toHaveBeenCalledTimes(2);
  });
});
