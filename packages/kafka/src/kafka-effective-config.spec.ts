import { spawnSync } from "node:child_process";
import { dirname } from "node:path";

import type { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";

import { meta, testCase } from "@base/testing";

import { buildConsumerConfig, buildProducerConfig } from "./kafka-config.builder.js";

// What librdkafka actually runs with, not what the builder returns: the
// kafkajs-compat layer injects its own defaults (some under librdkafka
// aliases) and merges our object over them, so a key we set can still lose.
// A child process creates the client with `debug: "conf"` against a dead
// broker, collects librdkafka's "Client configuration" dump through the
// kafkaJS logger, prints it and kills itself (a clean exit would wait out the
// native connect) — the parent never waits on a broker.
const PROBE = String.raw`
import { createRequire } from "node:module";
const require = createRequire(process.cwd() + "/package.json");
const { KafkaJS } = require("@confluentinc/kafka-javascript");
const { role, config, keys } = JSON.parse(process.argv[1]);
const seen = {};
const capture = (m) => {
  const hit = /^\[thrd:[^\]]*\]:\s+(\S+) = (.*)$/.exec(String(m));
  if (hit) seen[hit[1]] = hit[2];
};
const logger = { info: capture, debug: capture, warn() {}, error() {}, namespace() { return this; }, setLogLevel() {} };
// The kafkaJS block the clients get (reconnect.ts kafkaJsConfig), with the probe's logger.
const kafka = new KafkaJS.Kafka({ "bootstrap.servers": "127.0.0.1:1", kafkaJS: { logger, retry: { retries: 0 } } });
const client = role === "consumer" ? kafka.consumer({ ...config, debug: "conf" }) : kafka.producer({ ...config, debug: "conf" });
client.connect().catch(() => {});
const deadline = Date.now() + 5000;
while (Date.now() < deadline && !keys.every((k) => k in seen)) await new Promise((r) => setTimeout(r, 20));
// process.exit would wait on the native connect: write, then go.
require("node:fs").writeSync(1, JSON.stringify(seen));
process.kill(process.pid, "SIGKILL");
`;

const packageDir = dirname(import.meta.dirname);

function effective(
  role: "consumer" | "producer",
  config: Record<string, unknown>,
  keys: string[],
): Record<string, string> {
  const run = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", PROBE, JSON.stringify({ role, config, keys })],
    { cwd: packageDir, encoding: "utf8", timeout: 20_000 },
  );
  if (run.stdout === "") throw new Error(`config probe printed nothing: ${run.stderr}`);
  return JSON.parse(run.stdout) as Record<string, string>;
}

function stub(env: Record<string, string>): ConfigService {
  const all: Record<string, string> = { KAFKA_BROKERS: "127.0.0.1:1", ...env };
  return { get: (key: string) => all[key] } as unknown as ConfigService;
}

// Non-default values, so a client default can't pass for ours.
const env = stub({
  KAFKA_PRODUCER_QUEUE_MAX_KBYTES: "32768",
  KAFKA_PRODUCER_QUEUE_MAX_MESSAGES: "50000",
  KAFKA_MESSAGE_MAX_BYTES: "900000",
  KAFKA_PRODUCER_COMPRESSION_TYPE: "zstd",
  KAFKA_PRODUCER_LINGER_MS: "7",
  KAFKA_CONSUMER_QUEUE_MAX_KBYTES: "2048",
  KAFKA_CONSUMER_FETCH_MAX_BYTES: "3145728",
  KAFKA_CONSUMER_PARTITION_FETCH_MAX_BYTES: "524288",
  KAFKA_CONSUMER_SESSION_TIMEOUT_MS: "40000",
  KAFKA_CONSUMER_MAX_POLL_INTERVAL_MS: "200000",
  KAFKA_CONSUMER_ASSIGNMENT_STRATEGY: "cooperative-sticky",
});

describe("effective librdkafka config", () => {
  meta({ epic: "nodejs-basics", feature: "kafka", owner: "@team-platform", tags: ["kafka"] });

  // librdkafka dumps canonical names: fetch.message.max.bytes is the canonical
  // max.partition.fetch.bytes, compression.codec of compression.type,
  // queue.buffering.max.ms of linger.ms.
  it("the consumer runs with every named key, not a compat-layer default", async () => {
    await testCase("NB-1028", "consumer named keys reach librdkafka");
    const want = {
      "fetch.message.max.bytes": "524288",
      "fetch.max.bytes": "3145728",
      "receive.message.max.bytes": "3146240",
      "queued.max.messages.kbytes": "2048",
      "message.max.bytes": "900000",
      "session.timeout.ms": "40000",
      // The compat layer doubles it and enforces the configured value itself.
      "max.poll.interval.ms": "400000",
      "partition.assignment.strategy": "cooperative-sticky",
      "auto.offset.reset": "smallest",
      "enable.auto.commit": "false",
      // librdkafka's defaults, not the compat layer's 300 / 30000 (1.11+).
      "reconnect.backoff.ms": "100",
      "reconnect.backoff.max.ms": "10000",
    };
    const got = effective("consumer", buildConsumerConfig(env, "g"), Object.keys(want));
    expect(got).toMatchObject(want);
  });

  it("the producer runs with every named key", async () => {
    await testCase("NB-1029", "producer named keys reach librdkafka");
    const want = {
      "queue.buffering.max.kbytes": "32768",
      "queue.buffering.max.messages": "50000",
      "message.max.bytes": "900000",
      "compression.codec": "zstd",
      "queue.buffering.max.ms": "7",
      "enable.idempotence": "true",
      // retry.retries: 0 (one connect attempt) must not take the re-sends with it.
      "message.send.max.retries": "5",
      "reconnect.backoff.ms": "100",
      "reconnect.backoff.max.ms": "10000",
    };
    const got = effective("producer", buildProducerConfig(env), Object.keys(want));
    expect(got).toMatchObject(want);
  });
});
