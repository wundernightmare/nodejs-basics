import { type KafkaJS } from "@confluentinc/kafka-javascript";
import { ConfigService } from "@nestjs/config";
import { type Queue } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppLogger, pinoLogger } from "@base/logger";
import { ReadinessService } from "@base/observability";
import { meta, testCase } from "@base/testing";

import { JobQueueFullError, TaskEventsConsumer } from "./task-events.consumer.js";

const appLogger = new AppLogger(pinoLogger.child({}, { level: "silent" }));

interface Harness {
  consumer: TaskEventsConsumer;
  add: ReturnType<typeof vi.fn>;
  commitOffsets: ReturnType<typeof vi.fn>;
  waiting: ReturnType<typeof vi.fn>;
}

function harness(add = vi.fn(async () => ({})), env: Record<string, string> = {}): Harness {
  const waiting = vi.fn(() => Promise.resolve(0));
  const queue = { name: "task-events", add, getWaitingCount: waiting } as unknown as Queue;
  const consumer = new TaskEventsConsumer(
    new ConfigService(env),
    queue,
    appLogger,
    new ReadinessService([], appLogger),
  );
  const commitOffsets = vi.fn(async () => undefined);
  // The connected consumer is created in connectWithRetry; stand in for it.
  Object.assign(consumer, { consumer: { commitOffsets } });
  return { consumer, add, commitOffsets, waiting };
}

function payload(
  value: string | null,
  resume: () => unknown = vi.fn(),
  partition = 0,
): KafkaJS.EachMessagePayload & { pause: ReturnType<typeof vi.fn> } {
  return {
    topic: "tasks.events",
    partition,
    message: {
      key: null,
      value: value === null ? null : Buffer.from(value),
      offset: "7",
      timestamp: "0",
      attributes: 0,
      headers: {},
    },
    heartbeat: async () => {},
    pause: vi.fn(() => resume),
  };
}

const created = JSON.stringify({
  type: "task.created",
  id: "01J0000000000000000000000",
  title: "t",
});

describe("TaskEventsConsumer.handleMessage", () => {
  meta({
    epic: "nodejs-basics",
    feature: "worker",
    owner: "@team-platform",
    tags: ["worker", "kafka"],
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("commits the offset once the job is enqueued", async () => {
    await testCase("NB-900", "kafka consumer commits after handling");
    const h = harness();
    await h.consumer.handleMessage(payload(created));
    expect(h.add).toHaveBeenCalledOnce();
    // The next offset to read — not a bare commitOffsets(), which would commit
    // what the layer stored before this message.
    expect(h.commitOffsets).toHaveBeenCalledWith([
      { topic: "tasks.events", partition: 0, offset: "8" },
    ]);
  });

  it("commits and skips a message that can never be decoded", async () => {
    await testCase("NB-901", "kafka consumer skips poison messages");
    const h = harness();
    for (const value of ["not json", "null", "42", JSON.stringify({ type: "task.deleted" })]) {
      await h.consumer.handleMessage(payload(value));
    }
    expect(h.add).not.toHaveBeenCalled();
    expect(h.commitOffsets).toHaveBeenCalledTimes(4);
  });

  it("on a failed hand-off pauses the partition, does not commit, rethrows, resumes later", async () => {
    await testCase("NB-902", "kafka consumer backs off instead of hot-looping");
    const h = harness(
      vi.fn(async () => {
        throw new Error("valkey down");
      }),
    );
    const resume = vi.fn();
    const p = payload(created, resume);
    await expect(h.consumer.handleMessage(p)).rejects.toThrow("valkey down");
    expect(p.pause).toHaveBeenCalledOnce();
    expect(h.commitOffsets).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(resume).toHaveBeenCalledOnce();
  });

  it("doubles the pause on consecutive failures and resets it after a success", async () => {
    await testCase("NB-903", "kafka consumer retry backoff");
    let fail = true;
    const h = harness(
      vi.fn(async () => {
        if (fail) throw new Error("valkey down");
        return {};
      }),
    );
    const first = vi.fn();
    const second = vi.fn();
    await expect(h.consumer.handleMessage(payload(created, first))).rejects.toThrow();
    await expect(h.consumer.handleMessage(payload(created, second))).rejects.toThrow();
    vi.advanceTimersByTime(1_000);
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(second).toHaveBeenCalledOnce();

    fail = false;
    await h.consumer.handleMessage(payload(created));
    fail = true;
    const third = vi.fn();
    await expect(h.consumer.handleMessage(payload(created, third))).rejects.toThrow();
    vi.advanceTimersByTime(1_000);
    expect(third).toHaveBeenCalledOnce();
  });

  it("backs off per partition: one failing partition does not slow another down", async () => {
    await testCase("NB-932", "kafka consumer backoff is per partition");
    const h = harness(vi.fn(() => Promise.reject(new Error("valkey down"))));
    const p0a = vi.fn();
    const p0b = vi.fn();
    const p1 = vi.fn();
    await expect(h.consumer.handleMessage(payload(created, p0a, 0))).rejects.toThrow();
    await expect(h.consumer.handleMessage(payload(created, p0b, 0))).rejects.toThrow();
    await expect(h.consumer.handleMessage(payload(created, p1, 1))).rejects.toThrow();
    vi.advanceTimersByTime(1_000);
    expect(p1).toHaveBeenCalledOnce(); // partition 1: first failure → 1 s
    expect(p0b).not.toHaveBeenCalled(); // partition 0: second failure → 2 s
    vi.advanceTimersByTime(1_000);
    expect(p0b).toHaveBeenCalledOnce();
  });

  it("pauses the partition while the job queue is full, reading its depth at most once a second", async () => {
    await testCase("NB-940", "a full job queue pushes back on Kafka");
    const h = harness(undefined, { WORKER_QUEUE_MAX_WAITING: "100" });
    h.waiting.mockResolvedValue(100);
    const resume = vi.fn();
    const p = payload(created, resume);
    await expect(h.consumer.handleMessage(p)).rejects.toBeInstanceOf(JobQueueFullError);
    await expect(h.consumer.handleMessage(payload(created))).rejects.toBeInstanceOf(
      JobQueueFullError,
    );
    expect(h.waiting).toHaveBeenCalledOnce(); // cached
    expect(h.add).not.toHaveBeenCalled();
    expect(h.commitOffsets).not.toHaveBeenCalled();
    expect(p.pause).toHaveBeenCalledOnce();

    // Back-pressure backs off to 5 s at most, not the 60 s of a failure.
    for (let i = 0; i < 6; i++) {
      // oxlint-disable-next-line no-await-in-loop -- consecutive failures on one partition
      await expect(h.consumer.handleMessage(payload(created))).rejects.toThrow();
    }
    const late = vi.fn();
    await expect(h.consumer.handleMessage(payload(created, late))).rejects.toThrow();
    vi.advanceTimersByTime(5_000);
    expect(late).toHaveBeenCalledOnce();

    h.waiting.mockResolvedValue(99);
    vi.advanceTimersByTime(1_001);
    await h.consumer.handleMessage(payload(created));
    expect(h.add).toHaveBeenCalledOnce();
  });

  it("a burst inside one cache window cannot overshoot the limit", async () => {
    await testCase("NB-941", "job queue limit holds under a burst");
    const h = harness(undefined, { WORKER_QUEUE_MAX_WAITING: "2" });
    await h.consumer.handleMessage(payload(created));
    await h.consumer.handleMessage(payload(created));
    await expect(h.consumer.handleMessage(payload(created))).rejects.toBeInstanceOf(
      JobQueueFullError,
    );
    expect(h.add).toHaveBeenCalledTimes(2);
    expect(h.waiting).toHaveBeenCalledOnce();
  });

  it("a failed commit is logged, not thrown", async () => {
    await testCase("NB-904", "kafka consumer tolerates a failed commit");
    const h = harness();
    h.commitOffsets.mockRejectedValueOnce(new Error("rebalance in progress"));
    await expect(h.consumer.handleMessage(payload(created))).resolves.toBeUndefined();
  });
});
