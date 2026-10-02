import { KafkaJS } from "@confluentinc/kafka-javascript";
import { ConfigService } from "@nestjs/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppLogger, pinoLogger } from "@base/logger";
import { integration, meta, testCase, unique } from "@base/testing";

import { KafkaConsumerRunner } from "./kafka-consumer.js";
import { KafkaProducerService } from "./kafka.provider.js";

/**
 * The consumer loop against a real broker (`just deps` Redpanda, which
 * auto-creates the test's own topic). The scenario is the one a mock cannot
 * prove: a message produced while the consumer is down is handled after it
 * restarts, and nothing handled before is handled again — the group's
 * committed offset is the proof.
 */
const infra = integration("kafka");
const appLogger = new AppLogger(pinoLogger.child({}, { level: "silent" }));

async function until(cond: () => Promise<boolean> | boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  // oxlint-disable-next-line no-await-in-loop -- polling: each check waits for the last
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    // oxlint-disable-next-line no-await-in-loop -- the pause between checks
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
  }
}

describe.skipIf(infra.skip)("kafka consumer (integration)", () => {
  meta({
    epic: "nodejs-basics",
    feature: "kafka",
    owner: "@team-platform",
    tags: ["kafka", "integration"],
  });

  const topic = unique("it-topic");
  const groupId = unique("it-group");
  let config: ConfigService;
  let producer: KafkaProducerService;
  let admin: KafkaJS.Admin;

  beforeAll(async () => {
    config = new ConfigService({
      KAFKA_BROKERS: infra.url("kafka"),
      // A fresh group on a fresh topic reads it from the start.
      KAFKA_CONSUMER_AUTO_OFFSET_RESET: "earliest",
    });
    producer = new KafkaProducerService(config, appLogger);
    producer.onApplicationBootstrap();
    admin = new KafkaJS.Kafka({ kafkaJS: { brokers: [infra.url("kafka")], logLevel: 0 } }).admin();
    await admin.connect();
  });
  afterAll(async () => {
    await admin.disconnect();
    await producer.onApplicationShutdown();
  });

  const committed = async (): Promise<string | undefined> => {
    const [entry] = await admin.fetchOffsets({ groupId, topics: [topic] });
    return entry?.partitions[0]?.offset;
  };

  it("handles what was produced while it was down, and nothing twice", async () => {
    await testCase("NB-944", "kafka consumer resumes from its committed offset");
    const seen: string[] = [];
    const start = (): KafkaConsumerRunner => {
      const runner = new KafkaConsumerRunner(config, appLogger.child("it"), {
        groupId,
        topics: [topic],
        handle: (message) => {
          seen.push(String(message.value));
          return Promise.resolve();
        },
      });
      runner.start();
      return runner;
    };

    // waitMs: the producer connects in the background; the first send creates the topic.
    await producer.send({ topic, messages: [{ value: "m1" }] }, { waitMs: 15_000 });
    const first = start();
    await until(async () => (await committed()) === "1");
    await first.stop();

    await producer.send({ topic, messages: [{ value: "m2" }] });
    const second = start();
    await until(async () => (await committed()) === "2");
    await second.stop();

    expect(seen).toEqual(["m1", "m2"]);
  }, 90_000);
});
