import { ConfigService } from "@nestjs/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppLogger, pinoLogger } from "@base/logger";
import { integration, meta, testCase, unique } from "@base/testing";

import { KafkaConsumerRunner, KafkaPermanentError } from "./kafka-consumer.js";
import { KafkaProducerService } from "./kafka.provider.js";

/**
 * The consumer loop against a real broker (`just deps` Redpanda, which
 * auto-creates the test's own topic). The scenario is the one a mock cannot
 * prove: a message produced while the consumer is down is handled after it
 * restarts, and nothing handled before is handled again. (A bare
 * `commitOffsets()` commits one message behind; no commit re-reads the topic
 * from the start — either way the second run sees m1 again.)
 *
 * Not asserted through admin.fetchOffsets: kafka-javascript 1.10.x segfaults
 * the process on it for a group that does not exist yet (seen on CI and on
 * Redpanda 26.1.8).
 */
const infra = integration("kafka");
const appLogger = new AppLogger(pinoLogger.child({}, { level: "silent" }));

async function until(cond: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
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

  beforeAll(() => {
    config = new ConfigService({
      KAFKA_BROKERS: infra.url("kafka"),
      // A fresh group on a fresh topic reads it from the start.
      KAFKA_CONSUMER_AUTO_OFFSET_RESET: "earliest",
    });
    producer = new KafkaProducerService(config, appLogger);
    producer.onApplicationBootstrap();
  });
  afterAll(async () => {
    await producer.onApplicationShutdown();
  });

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
    await until(() => seen.includes("m1"));
    // stop() waits for the message in flight, its commit included.
    await first.stop();

    await producer.send({ topic, messages: [{ value: "m2" }] });
    const second = start();
    await until(() => seen.includes("m2"));
    await second.stop();

    expect(seen).toEqual(["m1", "m2"]);
  }, 90_000);

  it("parks a message it can never handle on {topic}.dlq and moves on", async () => {
    await testCase(
      "NB-1023",
      "a poison message reaches the dead-letter topic, the next one is handled",
    );
    const source = unique("it-dlq");
    const parked: { value: string; headers: Record<string, string> }[] = [];
    const handled: string[] = [];
    // Its own consumer asks the broker for the dead-letter topic first (auto-created here).
    const dlq = new KafkaConsumerRunner(config, appLogger.child("it-dlq"), {
      groupId: unique("it-dlq-group"),
      topics: [`${source}.dlq`],
      handle: (message) => {
        const headers = Object.fromEntries(
          Object.entries(message.headers ?? {}).map(([k, v]) => [k, String(v)]),
        );
        parked.push({ value: String(message.value), headers });
        return Promise.resolve();
      },
    });
    dlq.start();
    const main = new KafkaConsumerRunner(config, appLogger.child("it-main"), {
      groupId: unique("it-main-group"),
      topics: [source],
      producer,
      handle: (message) => {
        const value = String(message.value);
        if (value === "poison") return Promise.reject(new KafkaPermanentError("cannot decode"));
        handled.push(value);
        return Promise.resolve();
      },
    });
    await producer.send(
      { topic: source, messages: [{ value: "poison" }, { value: "fine" }] },
      { waitMs: 15_000 },
    );
    main.start();
    await until(() => handled.includes("fine") && parked.length === 1);
    await Promise.all([main.stop(), dlq.stop()]);

    expect(parked[0]?.value).toBe("poison");
    expect(parked[0]?.headers).toMatchObject({
      dlq_reason: "permanent",
      dlq_error: "cannot decode",
      dlq_source_topic: source,
      dlq_source_offset: "0",
      dlq_attempts: "1",
    });
  }, 90_000);
});
