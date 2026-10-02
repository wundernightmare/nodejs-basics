import { type BatchObservableCallback, type Meter, metrics } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";

import { meta, testCase } from "@base/testing";

import { kafkaClientMetrics } from "./kafka-metrics.js";

/** Stats payloads in the shape librdkafka 2.x reported against the local Redpanda, trimmed. */
const PRODUCER = {
  type: "producer",
  msg_size: 2_048,
  msg_size_max: 67_108_864,
  brokers: {
    "localhost:9092/0": { nodeid: 0, state: "UP", req_timeouts: 1, txerrs: 2, rxerrs: 0 },
    GroupCoordinator: { nodeid: -1, state: "UP", req_timeouts: 9 },
  },
};
const CONSUMER = {
  type: "consumer",
  brokers: { "localhost:9092/0": { nodeid: 0, state: "UP" } },
  topics: {
    "tasks.events": {
      partitions: {
        "0": { consumer_lag: 7 },
        "1": { consumer_lag: -1 },
        "2": { consumer_lag: 3 },
        "-1": { consumer_lag: -1 },
      },
    },
  },
  cgrp: { rebalance_cnt: 2 },
};

const instrument = (name: string): { name: string } => ({ name });

/** A meter that names every instrument and runs the batch callback on demand. */
function fakeMeter(): { collect: () => string[]; callbacks: () => number } {
  const callbacks: BatchObservableCallback[] = [];
  vi.spyOn(metrics, "getMeter").mockReturnValue({
    createObservableGauge: instrument,
    createObservableCounter: instrument,
    addBatchObservableCallback: (cb: BatchObservableCallback) => callbacks.push(cb),
    removeBatchObservableCallback: (cb: BatchObservableCallback) => {
      callbacks.splice(callbacks.indexOf(cb), 1);
    },
  } as unknown as Meter);
  return {
    collect: () => {
      const out: string[] = [];
      for (const cb of callbacks) {
        void cb({
          observe: (o: unknown, v: number, a?: Record<string, unknown>) => {
            const { "kafka.client.role": _role, ...rest } = a ?? {};
            out.push(
              `${(o as { name: string }).name} ${v}${Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : ""}`,
            );
          },
        });
      }
      return out;
    },
    callbacks: () => callbacks.length,
  };
}

const wrap = (s: object): { message: string } => ({ message: JSON.stringify(s) });

describe("kafkaClientMetrics", () => {
  meta({ epic: "nodejs-basics", feature: "kafka", owner: "@team-platform", tags: ["kafka"] });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("producer: brokers up, errors over real brokers, queue fill against its bound", async () => {
    await testCase("NB-919", "producer metrics from librdkafka statistics");
    const m = fakeMeter();
    const client = kafkaClientMetrics("producer");
    expect(m.collect()).toEqual([]); // nothing until the first report
    client.statsCb(wrap(PRODUCER));
    expect(m.collect()).toEqual([
      "kafka.client.brokers.up 1",
      "kafka.client.request.errors 3",
      "kafka.client.producer.queue.size 2048",
      "kafka.client.producer.queue.size.limit 67108864",
    ]);
  });

  it("consumer: lag max/sum over known partitions, rebalances — one series each", async () => {
    await testCase("NB-920", "consumer metrics from librdkafka statistics");
    const m = fakeMeter();
    kafkaClientMetrics("consumer").statsCb(JSON.stringify(CONSUMER)); // bare JSON is accepted too
    expect(m.collect()).toEqual([
      "kafka.client.brokers.up 1",
      "kafka.client.request.errors 0",
      "kafka.client.consumer.lag.max 7",
      "kafka.client.consumer.lag.sum 10",
      "kafka.client.consumer.rebalances 2",
    ]);
  });

  it("exports the same series for 500 topics as for one — no topic/partition labels", async () => {
    await testCase("NB-923", "kafka client metrics have fixed cardinality");
    const m = fakeMeter();
    const topics: Record<string, { partitions: Record<string, { consumer_lag: number }> }> = {};
    for (let i = 0; i < 500; i++) {
      const partitions: Record<string, { consumer_lag: number }> = {};
      for (let p = 0; p < 12; p++) partitions[String(p)] = { consumer_lag: i + p };
      topics[`topic-${i}`] = { partitions };
    }
    kafkaClientMetrics("consumer").statsCb(wrap({ ...CONSUMER, topics }));
    const many = m.collect();
    expect(many).toHaveLength(5);
    expect(many).toContain("kafka.client.consumer.lag.max 510");
  });

  it("ignores garbage, stops observing a stale snapshot and after dispose", async () => {
    await testCase("NB-921", "a silent client reports nothing");
    const m = fakeMeter();
    let t = 0;
    const client = kafkaClientMetrics("producer", {}, { maxAgeMs: 1_000, now: () => t });
    client.statsCb({ message: "{not json" });
    expect(m.collect()).toEqual([]);
    client.statsCb(wrap(PRODUCER));
    t = 1_001;
    expect(m.collect()).toEqual([]);
    client.dispose();
    expect(m.callbacks()).toBe(0);
  });
});
