import { type BatchObservableCallback, type Meter, metrics } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";

import { meta, testCase } from "@base/testing";

import { kafkaClientMetrics, parseStats } from "./kafka-metrics.js";

/**
 * Stats payloads trimmed from what librdkafka 2.x (kafka-javascript 1.10.1)
 * actually reported against the local Redpanda — same shape, fewer fields.
 */
const PRODUCER = {
  type: "producer",
  msg_cnt: 3,
  msg_size: 2_048,
  msg_size_max: 67_108_864,
  txmsgs: 41,
  brokers: {
    "localhost:9092/0": {
      nodeid: 0,
      state: "UP",
      req_timeouts: 1,
      txerrs: 2,
      rxerrs: 0,
      rtt: { p99: 2_500 },
    },
    GroupCoordinator: { nodeid: -1, state: "UP", req_timeouts: 9, rtt: { p99: 9_999 } },
  },
};
const CONSUMER = {
  type: "consumer",
  rxmsgs: 2_498,
  brokers: { "localhost:9092/0": { nodeid: 0, state: "UP", rtt: { p99: 501_759 } } },
  topics: {
    "tasks.events": {
      partitions: {
        "0": { consumer_lag: 7, fetchq_size: 1_000 },
        "1": { consumer_lag: -1, fetchq_size: 24 },
        "2": { consumer_lag: 3, fetchq_size: 0 },
        "-1": { consumer_lag: -1, fetchq_size: 0 },
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

  it("producer: queue fill against its bound, sent, errors, rtt of real brokers only", async () => {
    await testCase("NB-919", "producer metrics from librdkafka statistics");
    const m = fakeMeter();
    const client = kafkaClientMetrics("producer");
    expect(m.collect()).toEqual([]); // nothing until the first report
    client.statsCb(wrap(PRODUCER));
    expect(m.collect()).toEqual([
      "kafka.client.brokers.up 1",
      'kafka.client.request.errors 1 {"error.type":"timeout"}',
      'kafka.client.request.errors 2 {"error.type":"transmit"}',
      'kafka.client.request.errors 0 {"error.type":"receive"}',
      "kafka.client.producer.queue.messages 3",
      "kafka.client.producer.queue.size 2048",
      "kafka.client.producer.queue.size.limit 67108864",
      "kafka.client.messages.sent 41",
      'kafka.client.broker.rtt 2.5 {"kafka.broker.id":"0"}',
    ]);
  });

  it("consumer: lag max/sum over known partitions, prefetched bytes, rebalances; no fetch-poll rtt", async () => {
    await testCase("NB-920", "consumer metrics from librdkafka statistics");
    const m = fakeMeter();
    kafkaClientMetrics("consumer").statsCb(wrap(CONSUMER));
    const out = m.collect();
    expect(out).toContain("kafka.client.consumer.lag.max 7");
    expect(out).toContain("kafka.client.consumer.lag.sum 10");
    expect(out).toContain("kafka.client.consumer.fetch_queue.size 1024");
    expect(out).toContain("kafka.client.consumer.rebalances 2");
    expect(out).toContain("kafka.client.messages.received 2498");
    expect(out.some((l) => l.startsWith("kafka.client.broker.rtt"))).toBe(false);
  });

  it("exports the same number of series for 500 topics as for one — no topic/partition labels", async () => {
    await testCase("NB-923", "kafka client metrics have fixed cardinality");
    const m = fakeMeter();
    const one = kafkaClientMetrics("consumer");
    one.statsCb(wrap(CONSUMER));
    const single = m.collect();
    one.dispose();

    const topics: Record<string, { partitions: Record<string, { consumer_lag: number }> }> = {};
    for (let i = 0; i < 500; i++) {
      const partitions: Record<string, { consumer_lag: number }> = {};
      for (let p = 0; p < 12; p++) partitions[String(p)] = { consumer_lag: i + p };
      topics[`topic-${i}`] = { partitions };
    }
    kafkaClientMetrics("consumer").statsCb(wrap({ ...CONSUMER, topics }));
    const many = m.collect();
    expect(many).toHaveLength(single.length);
    expect(many.join("\n")).not.toMatch(/topic-|partition/u);
    expect(many).toContain("kafka.client.consumer.lag.max 510");
  });

  it("stops observing a stale snapshot and after dispose", async () => {
    await testCase("NB-921", "a silent client reports nothing");
    const m = fakeMeter();
    let t = 0;
    const client = kafkaClientMetrics("producer", {}, { maxAgeMs: 1_000, now: () => t });
    client.statsCb(wrap(PRODUCER));
    t = 1_001;
    expect(m.collect()).toEqual([]);
    client.dispose();
    expect(m.callbacks()).toBe(0);
  });

  it("parseStats takes the wrapped or bare JSON and rejects garbage", async () => {
    await testCase("NB-922", "statistics payload parsing");
    expect(parseStats(wrap({ msg_cnt: 1 }))).toEqual({ msg_cnt: 1 });
    expect(parseStats('{"msg_cnt":2}')).toEqual({ msg_cnt: 2 });
    expect(parseStats({ message: "{not json" })).toBeUndefined();
    expect(parseStats(null)).toBeUndefined();
  });
});
