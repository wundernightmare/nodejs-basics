import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { captureMetrics, meta, type MetricsCapture, metricValue, testCase } from "@base/testing";

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
  topics: { "tasks.events": { partitions: { "0": { consumer_lag: 7 } } } },
};

/** PRODUCER with one broker entry `b/0` that reported `txerrs`, plus `extra` entries. */
function broker(txerrs: number, extra: object = {}): object {
  return { ...PRODUCER, brokers: { "b/0": { nodeid: 0, state: "UP", txerrs }, ...extra } };
}

/** The kafka_* sample lines of a scrape, comments dropped. */
function kafkaLines(text: string): string[] {
  return text.split("\n").filter((l) => l.startsWith("kafka_"));
}

const wrap = (s: object): { message: string } => ({ message: JSON.stringify(s) });

describe("kafkaClientMetrics", () => {
  meta({ epic: "nodejs-basics", feature: "kafka", owner: "@team-platform", tags: ["kafka"] });
  let capture: MetricsCapture;
  beforeEach(() => {
    capture = captureMetrics();
  });
  afterEach(async () => {
    await capture.stop();
  });
  const errors = async (): Promise<number> =>
    metricValue(await capture.scrape(), "kafka_client_request_errors_total");

  it("producer: brokers up, errors over real brokers, queue fill against its bound", async () => {
    await testCase("NB-919", "producer metrics from librdkafka statistics");
    const client = kafkaClientMetrics("producer");
    expect(kafkaLines(await capture.scrape())).toEqual([]); // nothing until the first report
    client.statsCb(wrap(PRODUCER));
    expect(kafkaLines(await capture.scrape())).toEqual([
      'kafka_client_brokers_up{client="producer"} 1',
      'kafka_client_request_errors_total{client="producer"} 3',
      "kafka_producer_queue_bytes 2048",
      "kafka_producer_queue_max_bytes 67108864",
    ]);
  });

  it("consumer: brokers and errors only — lag is the broker's number", async () => {
    await testCase("NB-920", "consumer metrics from librdkafka statistics");
    kafkaClientMetrics("consumer").statsCb(JSON.stringify(CONSUMER)); // bare JSON is accepted too
    expect(kafkaLines(await capture.scrape())).toEqual([
      'kafka_client_brokers_up{client="consumer"} 1',
      'kafka_client_request_errors_total{client="consumer"} 0',
    ]);
  });

  it("request errors only grow, though librdkafka's per-broker counts restart", async () => {
    await testCase("NB-1040", "kafka_client_request_errors_total is a real counter");
    const client = kafkaClientMetrics("producer");
    client.statsCb(wrap(broker(5)));
    expect(await errors()).toBe(5);
    client.statsCb(wrap(broker(7, { "c/1": { nodeid: 1, state: "UP", txerrs: 1 } })));
    expect(await errors()).toBe(8);
    client.statsCb(wrap(broker(2))); // b/0 recreated, c/1 gone: the sum fell to 2
    expect(await errors()).toBe(10);
  });

  it("ignores garbage; a client that stopped reporting is connected to no broker", async () => {
    await testCase("NB-921", "a silent client is not reported as healthy");
    let t = 0;
    const client = kafkaClientMetrics("producer", { maxAgeMs: 1_000, now: () => t });
    client.statsCb({ message: "{not json" });
    expect(kafkaLines(await capture.scrape())).toEqual([]);
    client.statsCb(wrap(PRODUCER));
    expect(metricValue(await capture.scrape(), "kafka_client_brokers_up")).toBe(1);
    t = 1_001;
    expect(metricValue(await capture.scrape(), "kafka_client_brokers_up")).toBe(0);
    t = 0;
    client.dispose();
    client.statsCb(wrap({ ...PRODUCER, msg_size: 1 }));
    expect(metricValue(await capture.scrape(), "kafka_producer_queue_bytes")).toBe(2048);
  });
});
