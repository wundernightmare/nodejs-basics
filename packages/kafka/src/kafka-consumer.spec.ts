import { type KafkaJS } from "@confluentinc/kafka-javascript";
import { ConfigService } from "@nestjs/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppLogger, pinoLogger } from "@base/logger";
import { captureMetrics, meta, metricValue, testCase } from "@base/testing";

import {
  KafkaBackpressureError,
  KafkaConsumerRunner,
  KafkaPermanentError,
} from "./kafka-consumer.js";
import type { KafkaProducerService } from "./kafka.provider.js";

const logger = new AppLogger(pinoLogger.child({}, { level: "silent" })).child("test");

/** A runner around `handle`, with a stand-in for the connected consumer (and a producer). */
function runner(
  handle: () => Promise<void> = () => Promise.resolve(),
  dlq?: { send?: () => Promise<unknown>; config?: Record<string, string> },
): {
  runner: KafkaConsumerRunner;
  commitOffsets: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(dlq?.send ?? (() => Promise.resolve([])));
  const r = new KafkaConsumerRunner(new ConfigService(dlq?.config ?? {}), logger, {
    groupId: "g",
    topics: ["t"],
    handle,
    producer: dlq === undefined ? undefined : ({ send } as unknown as KafkaProducerService),
  });
  const commitOffsets = vi.fn(() => Promise.resolve());
  Object.assign(r, { consumer: { commitOffsets } });
  return { runner: r, commitOffsets, send };
}

function payload(
  partition = 0,
  resume: () => unknown = vi.fn(),
): KafkaJS.EachMessagePayload & { pause: ReturnType<typeof vi.fn> } {
  return {
    topic: "t",
    partition,
    message: { key: null, value: null, offset: "7", timestamp: "0", attributes: 0, headers: {} },
    heartbeat: () => Promise.resolve(),
    pause: vi.fn(() => resume),
  };
}

// A keyed message carrying its own headers, one of them a stale dlq_* the DLQ must replace.
function dlqCandidate(): KafkaJS.EachMessagePayload {
  const p = payload();
  p.message.key = Buffer.from("k");
  p.message.value = Buffer.from("v");
  p.message.headers = { traceparent: "tp", dlq_reason: "stale" };
  return p;
}

const failing = (err: Error = new Error("down")): (() => Promise<void>) =>
  vi.fn(() => Promise.reject(err));

describe("KafkaConsumerRunner.handleMessage", () => {
  meta({ epic: "nodejs-basics", feature: "kafka", owner: "@team-platform", tags: ["kafka"] });
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("commits the NEXT offset once the handler resolves", async () => {
    await testCase("NB-900", "kafka consumer commits after handling");
    const h = runner();
    await h.runner.handleMessage(payload());
    // Not a bare commitOffsets(): that commits what was stored before this message.
    expect(h.commitOffsets).toHaveBeenCalledWith([{ topic: "t", partition: 0, offset: "8" }]);
  });

  it("on a failure: pauses, does not commit, rethrows, resumes after a doubling per-partition backoff", async () => {
    await testCase("NB-902", "kafka consumer backs off per partition instead of hot-looping");
    const h = runner(failing());
    const first = vi.fn();
    const second = vi.fn();
    const other = vi.fn();
    await expect(h.runner.handleMessage(payload(0, first))).rejects.toThrow("down");
    await expect(h.runner.handleMessage(payload(0, second))).rejects.toThrow("down");
    await expect(h.runner.handleMessage(payload(1, other))).rejects.toThrow("down");
    expect(h.commitOffsets).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(first).toHaveBeenCalledOnce();
    expect(other).toHaveBeenCalledOnce(); // partition 1: its own first failure
    expect(second).not.toHaveBeenCalled(); // partition 0: second failure → 2 s
    vi.advanceTimersByTime(1_000);
    expect(second).toHaveBeenCalledOnce();
  });

  it("caps the backoff for back-pressure at 5 s", async () => {
    await testCase("NB-940", "back-pressure is re-checked soon");
    const h = runner(failing(new KafkaBackpressureError("queue full")));
    for (let i = 0; i < 6; i++) {
      await expect(h.runner.handleMessage(payload())).rejects.toThrow();
    }
    const late = vi.fn();
    await expect(h.runner.handleMessage(payload(0, late))).rejects.toThrow();
    vi.advanceTimersByTime(5_000);
    expect(late).toHaveBeenCalledOnce();
  });

  it("a failed commit is logged, not thrown", async () => {
    await testCase("NB-904", "kafka consumer tolerates a failed commit");
    const h = runner();
    h.commitOffsets.mockRejectedValueOnce(new Error("rebalance in progress"));
    await expect(h.runner.handleMessage(payload())).resolves.toBeUndefined();
  });

  it("after KAFKA_CONSUMER_MAX_RETRIES parks the message on {topic}.dlq and commits it", async () => {
    await testCase("NB-1019", "one poison message costs its retries, not the partition");
    const h = runner(failing(new Error("boom")), {});
    for (let i = 0; i < 5; i++) {
      await expect(h.runner.handleMessage(dlqCandidate())).rejects.toThrow("boom");
    }
    expect(h.send).not.toHaveBeenCalled();
    await expect(h.runner.handleMessage(dlqCandidate())).resolves.toBeUndefined(); // the 6th failure
    expect(h.send).toHaveBeenCalledWith({
      topic: "t.dlq",
      messages: [
        {
          key: Buffer.from("k"),
          value: Buffer.from("v"),
          headers: {
            traceparent: "tp",
            dlq_reason: "retries_exhausted",
            dlq_error: "boom",
            dlq_source_topic: "t",
            dlq_source_partition: "0",
            dlq_source_offset: "7",
            dlq_attempts: "6",
          },
        },
      ],
    });
    expect(h.commitOffsets).toHaveBeenCalledWith([{ topic: "t", partition: 0, offset: "8" }]);
  });

  it("a permanent error is parked at once; back-pressure never is", async () => {
    await testCase("NB-1020", "the handler says which failures retrying cannot fix");
    const permanent = runner(failing(new KafkaPermanentError("not a task.created")), {});
    await expect(permanent.runner.handleMessage(payload())).resolves.toBeUndefined();
    expect(permanent.send.mock.calls[0]).toMatchObject([
      { messages: [{ headers: { dlq_reason: "permanent", dlq_attempts: "1" } }] },
    ]);

    const busy = runner(failing(new KafkaBackpressureError("queue full")), {});
    for (let i = 0; i < 10; i++) {
      await expect(busy.runner.handleMessage(payload())).rejects.toThrow("queue full");
    }
    expect(busy.send).not.toHaveBeenCalled();
  });

  it("keeps the message when it cannot be parked: send failed, `none`, or no producer", async () => {
    await testCase("NB-1021", "nothing is skipped unless it reached the dead-letter topic");
    const down = runner(failing(new KafkaPermanentError("bad")), {
      send: () => Promise.reject(new Error("unknown topic")),
    });
    const p = payload();
    await expect(down.runner.handleMessage(p)).rejects.toThrow("bad");
    expect(p.pause).toHaveBeenCalledOnce();
    expect(down.commitOffsets).not.toHaveBeenCalled();

    const none = runner(failing(new KafkaPermanentError("bad")), {
      config: { KAFKA_DEAD_LETTER_TOPIC: "none" },
    });
    await expect(none.runner.handleMessage(payload())).rejects.toThrow("bad");
    expect(none.send).not.toHaveBeenCalled();

    const plain = runner(failing(new KafkaPermanentError("bad")));
    await expect(plain.runner.handleMessage(payload())).rejects.toThrow("bad");
    expect(plain.commitOffsets).not.toHaveBeenCalled();
  });

  it("is not ready until it runs", async () => {
    await testCase("NB-903", "kafka consumer readiness");
    expect(() => {
      runner().runner.assertRunning();
    }).toThrow("not running");
  });

  it("counts each record once by its final outcome, the topic bounded by the subscription", async () => {
    await testCase("NB-1041", "kafka_consumer_records_total / handler duration / commit errors");
    const capture = captureMetrics();
    try {
      const count = async (labels: Record<string, string>): Promise<number> =>
        metricValue(await capture.scrape(), "kafka_consumer_records_total", labels);

      const ok = runner();
      await ok.runner.handleMessage(payload());
      await ok.runner.handleMessage({ ...payload(), topic: "matched-by-a-regex" });
      ok.commitOffsets.mockRejectedValueOnce(new Error("rebalance in progress"));
      await ok.runner.handleMessage(payload());

      let calls = 0;
      const flaky = runner(() =>
        calls++ === 0 ? Promise.reject(new Error("once")) : Promise.resolve(),
      );
      await expect(flaky.runner.handleMessage(payload())).rejects.toThrow("once");
      await flaky.runner.handleMessage(payload());

      const parked = runner(failing(new KafkaPermanentError("bad")), {});
      await parked.runner.handleMessage(payload());

      const stuck = runner(failing(new KafkaPermanentError("bad")));
      await expect(stuck.runner.handleMessage(payload())).rejects.toThrow("bad");
      await expect(stuck.runner.handleMessage(payload())).rejects.toThrow("bad");

      expect(await count({ topic: "t", result: "ok" })).toBe(2);
      expect(await count({ topic: "other", result: "ok" })).toBe(1);
      expect(await count({ topic: "t", result: "retried" })).toBe(1);
      expect(await count({ topic: "t", result: "dead_lettered" })).toBe(1);
      expect(await count({ topic: "t", result: "failed" })).toBe(1); // given up on once, retried since
      const text = await capture.scrape();
      expect(metricValue(text, "kafka_consumer_commit_errors_total")).toBe(1);
      // Every attempt on "t" is timed: 2 ok + 2 flaky + 1 parked + 2 stuck.
      expect(
        metricValue(text, "kafka_consumer_handler_duration_seconds_count", { topic: "t" }),
      ).toBe(7);
    } finally {
      await capture.stop();
    }
  });
});
