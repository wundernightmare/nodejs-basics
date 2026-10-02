import { type KafkaJS } from "@confluentinc/kafka-javascript";
import { ConfigService } from "@nestjs/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppLogger, pinoLogger } from "@base/logger";
import { meta, testCase } from "@base/testing";

import { KafkaBackpressureError, KafkaConsumerRunner } from "./kafka-consumer.js";

const logger = new AppLogger(pinoLogger.child({}, { level: "silent" })).child("test");

/** A runner around `handle`, with a stand-in for the connected consumer. */
function runner(handle: () => Promise<void> = () => Promise.resolve()): {
  runner: KafkaConsumerRunner;
  commitOffsets: ReturnType<typeof vi.fn>;
} {
  const r = new KafkaConsumerRunner(new ConfigService({}), logger, {
    groupId: "g",
    topics: ["t"],
    handle,
  });
  const commitOffsets = vi.fn(() => Promise.resolve());
  Object.assign(r, { consumer: { commitOffsets } });
  return { runner: r, commitOffsets };
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
      // oxlint-disable-next-line no-await-in-loop -- consecutive failures on one partition
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

  it("is not ready until it runs", async () => {
    await testCase("NB-903", "kafka consumer readiness");
    expect(() => {
      runner().runner.assertRunning();
    }).toThrow("not running");
  });
});
