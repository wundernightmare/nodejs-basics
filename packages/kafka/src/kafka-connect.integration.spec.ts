import { type KafkaJS } from "@confluentinc/kafka-javascript";
import { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";

import { AppLogger } from "@base/logger";
import { captureLogs, meta, testCase } from "@base/testing";

import { KafkaConsumerRunner } from "./kafka-consumer.js";
import { KafkaProducerService } from "./kafka.provider.js";

/**
 * Connecting without a broker, with the real client: the clients connect in
 * the background, and Reconnect (reconnect.ts) owns the retrying. Since
 * kafka-javascript 1.11 the compat connect() retries by itself unless told
 * not to (kafkaJsConfig: `retry.retries: 0`); left on, a dead broker is
 * reported only after ~80 s of hidden attempts, and that loop outlives the
 * shutdown. No broker needed — 127.0.0.1:1 refuses every connection.
 */
const NO_BROKER = "127.0.0.1:1";
// One attempt: the connection-setup timeout (11 s) + 1 s, and for the
// consumer its createTopics ask before it (5 s). The client's own retry loop
// would take ~80 s more; anything near that means it is back on.
const ONE_PRODUCER_ATTEMPT_MS = 20_000;
const ONE_CONSUMER_ATTEMPT_MS = 25_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function until(cond: () => boolean, ms: number): Promise<number> {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > ms) throw new Error(`timed out after ${ms} ms`);
    await sleep(100);
  }
  return Date.now() - started;
}

/** The producer service, counting the clients it creates. */
class CountingProducer extends KafkaProducerService {
  created = 0;
  protected override createProducer(): KafkaJS.Producer {
    this.created += 1;
    return super.createProducer();
  }
}

describe("kafka connect without a broker (integration)", () => {
  meta({
    epic: "nodejs-basics",
    feature: "kafka",
    owner: "@team-platform",
    tags: ["kafka", "integration"],
  });

  const config = new ConfigService({ KAFKA_BROKERS: NO_BROKER });

  it("the producer reports a dead broker after one connect attempt and retries with its own backoff", async () => {
    await testCase("NB-1071", "producer connect() makes one attempt per retry");
    const logs = captureLogs({ messageKey: "message" });
    const producer = new CountingProducer(config, new AppLogger(logs.logger));
    const retried = (): Record<string, unknown>[] =>
      logs
        .lines()
        .filter((l) => String(l["message"]).startsWith("Kafka producer failed to connect"));

    producer.onApplicationBootstrap();
    const tookMs = await until(() => retried().length > 0, ONE_PRODUCER_ATTEMPT_MS);
    expect(tookMs).toBeGreaterThan(5_000); // a real attempt, not a config error
    expect(retried()[0]).toMatchObject({ "retry.delay_ms": 1_000 });
    expect(producer.created).toBe(1);

    // The next attempt is Reconnect's, with a fresh client, after its 1 s.
    await until(() => producer.created === 2, 5_000);
    await producer.onApplicationShutdown("SIGTERM");
    await expect(producer.send({ topic: "t", messages: [{ value: "v" }] })).rejects.toMatchObject({
      kind: "not_connected",
    });
  }, 60_000);

  it("shutdown does not wait for a connect in flight, and nothing reconnects after it", async () => {
    await testCase("NB-1072", "bounded producer shutdown while connecting");
    const logs = captureLogs({ messageKey: "message" });
    const producer = new CountingProducer(config, new AppLogger(logs.logger));
    producer.onApplicationBootstrap();
    await sleep(1_000); // the first attempt is in flight

    const started = Date.now();
    await producer.onApplicationShutdown("SIGTERM");
    expect(Date.now() - started).toBeLessThan(1_000);

    // Let the abandoned attempt end on its own: no retry, no second client,
    // no late event taking the process down (vitest fails on an uncaught one).
    await sleep(ONE_PRODUCER_ATTEMPT_MS);
    expect(producer.created).toBe(1);
    expect(logs.find((l) => String(l["message"]).includes("failed to connect"))).toBeUndefined();
    expect(logs.find((l) => l["message"] === "Kafka producer connected")).toBeUndefined();
  }, 60_000);

  it("the consumer reports a dead broker after one connect attempt, and stops at once", async () => {
    await testCase("NB-1073", "consumer connect() makes one attempt per retry");
    const logs = captureLogs({ messageKey: "message" });
    const runner = new KafkaConsumerRunner(config, new AppLogger(logs.logger).child("it"), {
      groupId: "it-no-broker",
      topics: ["it-no-broker"],
      handle: () => Promise.resolve(),
    });
    const retried = (): Record<string, unknown>[] =>
      logs.lines().filter((l) => l["message"] === "Kafka consumer failed to start — retrying");

    runner.start();
    await until(() => retried().length > 0, ONE_CONSUMER_ATTEMPT_MS);
    expect(retried()[0]).toMatchObject({ "retry.delay_ms": 1_000 });
    expect(() => {
      runner.assertRunning();
    }).toThrow("consumer not running");

    await sleep(1_500); // Reconnect's second attempt is in flight
    const started = Date.now();
    await runner.stop();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(retried()).toHaveLength(1);
  }, 60_000);
});
