import { type KafkaJS } from "@confluentinc/kafka-javascript";
import { ConfigService } from "@nestjs/config";
import { type Queue } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppLogger, pinoLogger } from "@base/logger";
import { ReadinessService } from "@base/observability";
import { meta, testCase } from "@base/testing";

import { TaskEventsConsumer } from "./task-events.consumer.js";

const appLogger = new AppLogger(pinoLogger.child({}, { level: "silent" }));

interface Harness {
  consumer: TaskEventsConsumer;
  add: ReturnType<typeof vi.fn>;
  commitOffsets: ReturnType<typeof vi.fn>;
}

function harness(add = vi.fn(async () => ({}))): Harness {
  const queue = { name: "task-events", add } as unknown as Queue;
  const consumer = new TaskEventsConsumer(
    new ConfigService({}),
    queue,
    appLogger,
    new ReadinessService([], appLogger),
  );
  const commitOffsets = vi.fn(async () => undefined);
  // The connected consumer is created in connectWithRetry; stand in for it.
  Object.assign(consumer, { consumer: { commitOffsets } });
  return { consumer, add, commitOffsets };
}

function payload(
  value: string | null,
  resume: () => void = vi.fn(),
): KafkaJS.EachMessagePayload & { pause: ReturnType<typeof vi.fn> } {
  return {
    topic: "tasks.events",
    partition: 0,
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

  it("a failed commit is logged, not thrown", async () => {
    await testCase("NB-904", "kafka consumer tolerates a failed commit");
    const h = harness();
    h.commitOffsets.mockRejectedValueOnce(new Error("rebalance in progress"));
    await expect(h.consumer.handleMessage(payload(created))).resolves.toBeUndefined();
  });
});
