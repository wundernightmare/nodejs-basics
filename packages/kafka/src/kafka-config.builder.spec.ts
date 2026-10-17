import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ConfigService } from "@nestjs/config";
import { afterEach, describe, expect, it, vi } from "vitest";

import { meta, testCase } from "@base/testing";

import {
  buildConsumerConfig,
  buildKafkaClientConfig,
  buildProducerConfig,
} from "./kafka-config.builder.js";

// Minimal ConfigService double: the real one reads process.env first, so an
// ambient KAFKA_BROKERS (`just deps`) would leak into these cases.
function stub(env: Record<string, string | undefined>): ConfigService {
  const all: Record<string, string | undefined> = { KAFKA_BROKERS: "localhost:9092", ...env };
  return { get: (key: string) => all[key] } as unknown as ConfigService;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("kafka config builders", () => {
  meta({ epic: "nodejs-basics", feature: "kafka", owner: "@team-platform", tags: ["kafka"] });

  it("defaults: local plaintext broker, durable lz4 producer, bounded queues, manual commit", async () => {
    await testCase("NB-789", "kafka defaults");
    vi.stubEnv("OTEL_SERVICE_NAME", "svc");
    expect(() => buildKafkaClientConfig(stub({ KAFKA_BROKERS: undefined }))).toThrow(
      "KAFKA_BROKERS is not set",
    );
    const env = stub({});
    expect(buildKafkaClientConfig(env)).toEqual({
      "metadata.broker.list": "localhost:9092",
      "client.id": "svc",
      // librdkafka's own reconnect backoff, written out (the compat layer would set 300 / 30000).
      "reconnect.backoff.ms": 100,
      "reconnect.backoff.max.ms": 10_000,
      "socket.keepalive.enable": true,
      "statistics.interval.ms": 15_000,
      "message.max.bytes": 1_000_000,
    });
    expect(buildProducerConfig(env)).toMatchObject({
      "client.id": "svc-producer",
      acks: "all",
      "enable.idempotence": true,
      "compression.type": "lz4",
      "linger.ms": 5,
      "message.timeout.ms": 30_000,
      "queue.buffering.max.kbytes": 65_536,
      "queue.buffering.max.messages": 100_000,
      retries: 5,
    });
    expect(buildConsumerConfig(env, "g")).toMatchObject({
      "client.id": "svc-consumer-g",
      "group.id": "g",
      "auto.offset.reset": "earliest",
      "partition.assignment.strategy": "cooperative-sticky",
      "enable.auto.commit": false,
      "allow.auto.create.topics": true,
      "queued.min.messages": 1_000,
      "queued.max.messages.kbytes": 4_096,
      "fetch.max.bytes": 4_194_304,
      "max.partition.fetch.bytes": 1_048_576,
      "receive.message.max.bytes": 4_194_816,
    });
  });

  it("maps every dedicated KAFKA_* key onto its librdkafka property", async () => {
    await testCase("NB-790", "kafka env keys");
    const env = stub({
      KAFKA_BROKERS: "k1:9091,k2:9091",
      KAFKA_CLIENT_ID: "explicit",
      KAFKA_SECURITY_PROTOCOL: "SASL_SSL",
      KAFKA_SASL_MECHANISM: "scram-sha-512",
      KAFKA_SASL_USERNAME: "alice",
      KAFKA_SASL_PASSWORD: "pw",
      KAFKA_SSL_CA_LOCATION: "/etc/ssl/ca.pem",
      KAFKA_SSL_CA_PEM: "ignored: LOCATION wins",
      KAFKA_SSL_ENDPOINT_IDENTIFICATION_ALGORITHM: "https",
      KAFKA_REQUEST_TIMEOUT_MS: "45000",
      KAFKA_METADATA_MAX_AGE_MS: "60000",
      KAFKA_RECONNECT_BACKOFF_MS: "200",
      KAFKA_RECONNECT_BACKOFF_MAX_MS: "5000",
      KAFKA_STATISTICS_INTERVAL_MS: "0",
      KAFKA_PRODUCER_ACKS: "1",
      KAFKA_PRODUCER_ENABLE_IDEMPOTENCE: "false",
      KAFKA_PRODUCER_COMPRESSION_TYPE: "zstd",
      KAFKA_PRODUCER_LINGER_MS: "50",
      KAFKA_PRODUCER_MESSAGE_TIMEOUT_MS: "10000",
      KAFKA_PRODUCER_QUEUE_MAX_KBYTES: "16384",
      KAFKA_PRODUCER_QUEUE_MAX_MESSAGES: "5000",
      KAFKA_MESSAGE_MAX_BYTES: "2000000",
      KAFKA_CONSUMER_QUEUE_MAX_KBYTES: "8192",
      KAFKA_CONSUMER_FETCH_MAX_BYTES: "8388608",
      KAFKA_CONSUMER_PARTITION_FETCH_MAX_BYTES: "2097152",
      KAFKA_CONSUMER_AUTO_OFFSET_RESET: "latest",
      KAFKA_CONSUMER_ASSIGNMENT_STRATEGY: "range",
      KAFKA_CONSUMER_ENABLE_AUTO_COMMIT: "true",
      KAFKA_CONSUMER_SESSION_TIMEOUT_MS: "20000",
      KAFKA_CONSUMER_MAX_POLL_INTERVAL_MS: "600000",
    });
    expect(buildKafkaClientConfig(env, "x")).toEqual({
      "metadata.broker.list": "k1:9091,k2:9091",
      "client.id": "explicit-x",
      "security.protocol": "sasl_ssl",
      "sasl.mechanism": "SCRAM-SHA-512",
      "sasl.username": "alice",
      "sasl.password": "pw",
      "ssl.ca.location": "/etc/ssl/ca.pem",
      "ssl.endpoint.identification.algorithm": "https",
      "socket.timeout.ms": 45_000,
      "topic.metadata.refresh.interval.ms": 60_000,
      "reconnect.backoff.ms": 200,
      "reconnect.backoff.max.ms": 5_000,
      "socket.keepalive.enable": true,
      "statistics.interval.ms": 0,
      "message.max.bytes": 2_000_000,
    });
    expect(buildProducerConfig(env)).toMatchObject({
      acks: "1",
      "enable.idempotence": false,
      "compression.type": "zstd",
      "linger.ms": 50,
      "message.timeout.ms": 10_000,
      "queue.buffering.max.kbytes": 16_384,
      "queue.buffering.max.messages": 5_000,
    });
    expect(buildConsumerConfig(env, "g")).toMatchObject({
      "auto.offset.reset": "latest",
      "partition.assignment.strategy": "range",
      "enable.auto.commit": true,
      "session.timeout.ms": 20_000,
      "max.poll.interval.ms": 600_000,
      "queued.max.messages.kbytes": 8_192,
      "fetch.max.bytes": 8_388_608,
      "max.partition.fetch.bytes": 2_097_152,
      "receive.message.max.bytes": 8_389_120,
    });
  });

  it("fails on an unparseable value, naming the key — never runs on a default nobody chose", async () => {
    await testCase("NB-791", "garbage config is an error, not a silent default");
    expect(() => buildProducerConfig(stub({ KAFKA_PRODUCER_ENABLE_IDEMPOTENCE: "maybe" }))).toThrow(
      'KAFKA_PRODUCER_ENABLE_IDEMPOTENCE="maybe": expected true or false',
    );
    expect(() => buildProducerConfig(stub({ KAFKA_PRODUCER_LINGER_MS: "soon" }))).toThrow(
      'KAFKA_PRODUCER_LINGER_MS="soon": expected an integer',
    );
  });

  it("the SASL password file wins over the inline password, trimmed; unreadable → error", async () => {
    await testCase("NB-792", "KAFKA_SASL_PASSWORD_FILE");
    const dir = mkdtempSync(join(tmpdir(), "nb-kafka-sasl-"));
    try {
      const file = join(dir, "password");
      writeFileSync(file, "from-file\n");
      const read = (path: string): unknown =>
        buildKafkaClientConfig(
          stub({ KAFKA_SASL_PASSWORD_FILE: path, KAFKA_SASL_PASSWORD: "inline" }),
        )["sasl.password"];
      expect(read(file)).toBe("from-file");
      expect(() => read(join(dir, "missing"))).toThrow(
        "KAFKA_SASL_PASSWORD_FILE=" +
          JSON.stringify(join(dir, "missing")) +
          ": expected a readable, non-empty file",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("materialises an inline CA PEM to a file and points librdkafka at it", async () => {
    await testCase("NB-794", "inline CA PEM → ssl.ca.location");
    const pem = "-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----\n";
    const location = buildKafkaClientConfig(stub({ KAFKA_SSL_CA_PEM: pem }))["ssl.ca.location"];
    expect(typeof location).toBe("string");
    expect(readFileSync(String(location), "utf8")).toBe(pem);
    rmSync(String(location));
  });

  it("extras: shared ones apply to every client, role ones only to theirs, both win over knobs", async () => {
    await testCase("NB-797", "KAFKA_*_EXTRA_PROPERTIES");
    const env = stub({
      KAFKA_PRODUCER_LINGER_MS: "20",
      KAFKA_EXTRA_PROPERTIES: JSON.stringify({ "socket.nagle.disable": "true", "linger.ms": "1" }),
      KAFKA_PRODUCER_EXTRA_PROPERTIES: JSON.stringify({ "linger.ms": "50" }),
      KAFKA_CONSUMER_EXTRA_PROPERTIES: JSON.stringify({ "fetch.wait.max.ms": "100" }),
    });
    const producer = buildProducerConfig(env);
    const consumer = buildConsumerConfig(env, "g");
    expect(producer).toMatchObject({ "linger.ms": "50", "socket.nagle.disable": "true" });
    expect(producer["fetch.wait.max.ms"]).toBeUndefined();
    expect(consumer).toMatchObject({ "fetch.wait.max.ms": "100", "socket.nagle.disable": "true" });
  });

  it.each(["KAFKA_EXTRA_PROPERTIES", "KAFKA_CONSUMER_EXTRA_PROPERTIES"])(
    "a malformed %s fails at boot instead of being dropped",
    async (key) => {
      await testCase("NB-798", "malformed extras are rejected");
      expect(() => buildConsumerConfig(stub({ [key]: "{oops" }), "g")).toThrow(
        `${key}=…: expected a JSON object`,
      );
      expect(() => buildConsumerConfig(stub({ [key]: "[1]" }), "g")).toThrow(/JSON object/u);
    },
  );

  it.each([
    ["KAFKA_EXTRA_PROPERTIES", "message.max.bytes", "KAFKA_MESSAGE_MAX_BYTES"],
    [
      "KAFKA_PRODUCER_EXTRA_PROPERTIES",
      "queue.buffering.max.kbytes",
      "KAFKA_PRODUCER_QUEUE_MAX_KBYTES",
    ],
    [
      "KAFKA_CONSUMER_EXTRA_PROPERTIES",
      "fetch.message.max.bytes",
      "KAFKA_CONSUMER_PARTITION_FETCH_MAX_BYTES",
    ],
    [
      "KAFKA_CONSUMER_EXTRA_PROPERTIES",
      "partition.assignment.strategy",
      "KAFKA_CONSUMER_ASSIGNMENT_STRATEGY",
    ],
  ])("%s may not set %s — it has its own key", async (key, property, owner) => {
    await testCase("NB-1024", "buffer sizes cannot come from an escape hatch");
    const env = stub({ [key]: JSON.stringify({ [property]: 1, "sasl.password": "s3cret" }) });
    const build = (): unknown =>
      key === "KAFKA_PRODUCER_EXTRA_PROPERTIES"
        ? buildProducerConfig(env)
        : buildConsumerConfig(env, "g");
    expect(build).toThrow(`${key}=…: expected no "${property}" — set ${owner} instead`);
    // The escape hatch may carry credentials: the message never repeats it.
    expect(build).not.toThrow(/s3cret/u);
  });
});
