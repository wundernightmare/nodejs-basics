import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigService } from "@nestjs/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppLogger, pinoLogger } from "@base/logger";
import { meta, testCase, unique, workspaceRoot } from "@base/testing";

import { KafkaConsumerRunner } from "./kafka-consumer.js";
import { KafkaProducerService } from "./kafka.provider.js";

/**
 * The client settings of examples/kafka-sasl-ssl against its broker: SCRAM
 * over TLS, a private CA from a file, the password from a file (both mounted
 * from a Secret in the example's configmap.yaml). Opt-in — CI has no such
 * broker: `just kafka-sasl-ssl-up`, then KAFKA_SASL_SSL_BROKERS=localhost:29095.
 */
const brokers = process.env["KAFKA_SASL_SSL_BROKERS"];
const appLogger = new AppLogger(pinoLogger.child({}, { level: "silent" }));

describe.skipIf(brokers === undefined)("kafka over SASL_SSL (integration)", () => {
  meta({
    epic: "nodejs-basics",
    feature: "kafka",
    owner: "@team-platform",
    tags: ["kafka", "integration"],
  });

  const example = join(workspaceRoot(), "examples/kafka-sasl-ssl");
  let secrets: string;
  let config: ConfigService;
  let producer: KafkaProducerService;

  beforeAll(() => {
    secrets = mkdtempSync(join(tmpdir(), "nb-kafka-sasl-"));
    writeFileSync(join(secrets, "password"), "app-secret\n");
    config = new ConfigService({
      KAFKA_BROKERS: brokers,
      KAFKA_SECURITY_PROTOCOL: "SASL_SSL",
      KAFKA_SASL_MECHANISM: "SCRAM-SHA-512",
      KAFKA_SASL_USERNAME: "app",
      KAFKA_SASL_PASSWORD_FILE: join(secrets, "password"),
      KAFKA_SSL_CA_LOCATION: join(example, "certs/ca.crt"),
      KAFKA_CONSUMER_AUTO_OFFSET_RESET: "earliest",
    });
    producer = new KafkaProducerService(config, appLogger);
    producer.onApplicationBootstrap();
  });
  afterAll(async () => {
    await producer.onApplicationShutdown();
    rmSync(secrets, { recursive: true, force: true });
  });

  it("produces and consumes through SCRAM-SHA-512 over TLS with a private CA", async () => {
    await testCase("NB-1026", "SASL_SSL with custom certificates end to end");
    const topic = unique("it-sasl-ssl");
    const seen: string[] = [];
    const runner = new KafkaConsumerRunner(config, appLogger.child("it-sasl"), {
      groupId: unique("it-sasl-group"),
      topics: [topic],
      handle: (message) => {
        seen.push(String(message.value));
        return Promise.resolve();
      },
    });
    // waitMs: the producer connects (TLS + SCRAM) in the background.
    await producer.send({ topic, messages: [{ value: "over-tls" }] }, { waitMs: 15_000 });
    runner.start();
    const deadline = Date.now() + 30_000;
    while (!seen.includes("over-tls") && Date.now() < deadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });
    }
    await runner.stop();
    expect(seen).toEqual(["over-tls"]);
  }, 60_000);
});
