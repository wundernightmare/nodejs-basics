import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildKafkaClientConfig", () => {
  meta({
    epic: "nodejs-basics",
    feature: "kafka",
    owner: "@team-platform",
    tags: ["kafka", "unit"],
  });

  it("defaults to plaintext localhost when nothing is set — local dev path", async () => {
    await testCase("NB-789", "no env → plaintext localhost:9092");
    vi.stubEnv("OTEL_SERVICE_NAME", undefined);
    const cfg = buildKafkaClientConfig(stub({}), "producer");
    expect(cfg).toEqual({ "metadata.broker.list": "localhost:9092", "client.id": "app-producer" });
  });

  it("derives client.id from OTEL_SERVICE_NAME when KAFKA_CLIENT_ID is unset", async () => {
    await testCase("NB-790", "client.id follows the service name");
    vi.stubEnv("OTEL_SERVICE_NAME", "orders-api");
    expect(buildKafkaClientConfig(stub({}))["client.id"]).toBe("orders-api");
    expect(buildKafkaClientConfig(stub({ KAFKA_CLIENT_ID: "explicit" }))["client.id"]).toBe(
      "explicit",
    );
  });

  it("emits SASL_SSL properties when the full credential set is configured", async () => {
    await testCase("NB-791", "SASL/TLS env → librdkafka properties");
    const cfg = buildKafkaClientConfig(
      stub({
        KAFKA_BROKERS: "k1.example.internal:9091,k2.example.internal:9091",
        KAFKA_CLIENT_ID: "svc",
        KAFKA_SECURITY_PROTOCOL: "SASL_SSL",
        KAFKA_SASL_MECHANISM: "scram-sha-512",
        KAFKA_SASL_USERNAME: "alice",
        KAFKA_SASL_PASSWORD: "pw",
        KAFKA_SSL_CA_LOCATION: "/etc/ssl/ca.pem",
        KAFKA_SSL_ENDPOINT_IDENTIFICATION_ALGORITHM: "https",
      }),
      "producer",
    );
    expect(cfg).toEqual({
      "metadata.broker.list": "k1.example.internal:9091,k2.example.internal:9091",
      "client.id": "svc-producer",
      // Protocol lowercased (librdkafka enum); mechanism uppercased (canonical SCRAM-SHA-XXX).
      "security.protocol": "sasl_ssl",
      "sasl.mechanism": "SCRAM-SHA-512",
      "sasl.username": "alice",
      "sasl.password": "pw",
      "ssl.ca.location": "/etc/ssl/ca.pem",
      "ssl.endpoint.identification.algorithm": "https",
    });
  });

  describe("KAFKA_SASL_PASSWORD_FILE", () => {
    let dir: string;
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("wins over KAFKA_SASL_PASSWORD and is trimmed of trailing newlines", async () => {
      await testCase("NB-792", "password file beats the inline password");
      dir = mkdtempSync(join(tmpdir(), "nb-kafka-sasl-"));
      const file = join(dir, "password");
      writeFileSync(file, "from-file\n");
      const cfg = buildKafkaClientConfig(
        stub({ KAFKA_SASL_PASSWORD_FILE: file, KAFKA_SASL_PASSWORD: "inline" }),
      );
      expect(cfg["sasl.password"]).toBe("from-file");
    });

    it("falls back to KAFKA_SASL_PASSWORD when the file cannot be read", async () => {
      await testCase("NB-793", "unreadable password file → inline password");
      dir = mkdtempSync(join(tmpdir(), "nb-kafka-sasl-"));
      const cfg = buildKafkaClientConfig(
        stub({ KAFKA_SASL_PASSWORD_FILE: join(dir, "missing"), KAFKA_SASL_PASSWORD: "inline" }),
      );
      expect(cfg["sasl.password"]).toBe("inline");
    });
  });

  it("materialises an inline CA PEM to a temp file and points librdkafka at it", async () => {
    await testCase("NB-794", "inline CA PEM → ssl.ca.location");
    const TMP = "/tmp/kafka-ca.pem";
    if (existsSync(TMP)) rmSync(TMP);

    const pem = "-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----\n";
    const cfg = buildKafkaClientConfig(stub({ KAFKA_SSL_CA_PEM: pem }));

    expect(cfg["ssl.ca.location"]).toBe(TMP);
    expect(readFileSync(TMP, "utf8")).toBe(pem);
    rmSync(TMP);
  });

  it("prefers the explicit CA location when both LOCATION and PEM are set", async () => {
    await testCase("NB-795", "CA location beats inline PEM");
    const cfg = buildKafkaClientConfig(
      stub({
        KAFKA_SSL_CA_LOCATION: "/mnt/secrets/ca.pem",
        KAFKA_SSL_CA_PEM: "inline-should-be-ignored",
      }),
    );
    expect(cfg["ssl.ca.location"]).toBe("/mnt/secrets/ca.pem");
  });

  it("applies socket tunables only when explicitly set so librdkafka defaults stay in charge", async () => {
    await testCase("NB-796", "socket tunables are opt-in");
    const withTunables = buildKafkaClientConfig(
      stub({
        KAFKA_REQUEST_TIMEOUT_MS: "45000",
        KAFKA_METADATA_MAX_AGE_MS: "120000",
        KAFKA_RECONNECT_BACKOFF_MS: "250",
        KAFKA_RECONNECT_BACKOFF_MAX_MS: "5000",
      }),
    );
    expect(withTunables).toMatchObject({
      "socket.timeout.ms": 45_000,
      "topic.metadata.refresh.interval.ms": 120_000,
      "reconnect.backoff.ms": 250,
      "reconnect.backoff.max.ms": 5000,
    });

    const bare = buildKafkaClientConfig(stub({ KAFKA_REQUEST_TIMEOUT_MS: "soon" }));
    expect(bare).not.toHaveProperty("socket.timeout.ms");
    expect(bare).not.toHaveProperty("topic.metadata.refresh.interval.ms");
    expect(bare).not.toHaveProperty("reconnect.backoff.ms");
    expect(bare).not.toHaveProperty("reconnect.backoff.max.ms");
  });

  it("merges KAFKA_EXTRA_PROPERTIES last so it overrides dedicated knobs", async () => {
    await testCase("NB-797", "escape hatch wins");
    const cfg = buildKafkaClientConfig(
      stub({
        KAFKA_REQUEST_TIMEOUT_MS: "30000",
        KAFKA_EXTRA_PROPERTIES: JSON.stringify({
          "socket.timeout.ms": "60000",
          "socket.keepalive.enable": "true",
        }),
      }),
    );
    expect(cfg["socket.timeout.ms"]).toBe("60000");
    expect(cfg["socket.keepalive.enable"]).toBe("true");
  });

  it("rejects a malformed KAFKA_EXTRA_PROPERTIES at build time instead of dropping it", async () => {
    await testCase("NB-798", "bad escape hatch fails at boot");
    expect(() => buildKafkaClientConfig(stub({ KAFKA_EXTRA_PROPERTIES: "{not-json" }))).toThrow(
      /not valid JSON/,
    );
    expect(() => buildKafkaClientConfig(stub({ KAFKA_EXTRA_PROPERTIES: "[1,2,3]" }))).toThrow(
      /JSON object/,
    );
    expect(() => buildKafkaClientConfig(stub({ KAFKA_EXTRA_PROPERTIES: "null" }))).toThrow(
      /JSON object/,
    );
  });
});

describe("buildProducerConfig", () => {
  meta({
    epic: "nodejs-basics",
    feature: "kafka",
    owner: "@team-platform",
    tags: ["kafka", "unit"],
  });

  it("defaults to durable flags (acks=all + idempotence + zstd) on a -producer client id", async () => {
    await testCase("NB-799", "producer durability defaults");
    const cfg = buildProducerConfig(stub({ KAFKA_CLIENT_ID: "svc" }));
    expect(cfg).toMatchObject({
      "client.id": "svc-producer",
      acks: "all",
      "enable.idempotence": true,
      "compression.type": "zstd",
      "linger.ms": 10,
      "message.timeout.ms": 30_000,
    });
  });

  it("honours operator overrides that trade durability for throughput", async () => {
    await testCase("NB-800", "producer overrides");
    const cfg = buildProducerConfig(
      stub({
        KAFKA_PRODUCER_ACKS: "1",
        KAFKA_PRODUCER_ENABLE_IDEMPOTENCE: "false",
        KAFKA_PRODUCER_COMPRESSION_TYPE: "none",
        KAFKA_PRODUCER_LINGER_MS: "50",
        KAFKA_PRODUCER_MESSAGE_TIMEOUT_MS: "60000",
      }),
    );
    expect(cfg).toMatchObject({
      acks: "1",
      "enable.idempotence": false,
      "compression.type": "none",
      "linger.ms": 50,
      "message.timeout.ms": 60_000,
    });
  });

  it("keeps the default on an unparseable boolean instead of guessing", async () => {
    await testCase("NB-801", "garbage idempotence flag keeps idempotence on");
    const cfg = buildProducerConfig(stub({ KAFKA_PRODUCER_ENABLE_IDEMPOTENCE: "nope" }));
    expect(cfg["enable.idempotence"]).toBe(true);
  });

  it("lets KAFKA_EXTRA_PROPERTIES override the role flags too", async () => {
    await testCase("NB-802", "escape hatch beats producer flags");
    const cfg = buildProducerConfig(
      stub({ KAFKA_EXTRA_PROPERTIES: JSON.stringify({ acks: "0", "linger.ms": "0" }) }),
    );
    expect(cfg["acks"]).toBe("0");
    expect(cfg["linger.ms"]).toBe("0");
  });
});

describe("buildConsumerConfig", () => {
  meta({
    epic: "nodejs-basics",
    feature: "kafka",
    owner: "@team-platform",
    tags: ["kafka", "unit"],
  });

  it("defaults to at-least-once (manual commit) + latest offset + topic auto-create", async () => {
    await testCase("NB-803", "consumer defaults");
    const cfg = buildConsumerConfig(stub({ KAFKA_CLIENT_ID: "svc" }), "my-group");
    expect(cfg).toMatchObject({
      "client.id": "svc-consumer-my-group",
      "group.id": "my-group",
      "auto.offset.reset": "latest",
      "allow.auto.create.topics": true,
      "enable.auto.commit": false,
      "session.timeout.ms": 10_000,
      "max.poll.interval.ms": 300_000,
    });
  });

  it("bounds prefetch so a deep backlog cannot OOM the pod", async () => {
    await testCase("NB-804", "bounded consumer prefetch");
    const cfg = buildConsumerConfig(stub({}), "my-group");
    expect(cfg["queued.min.messages"]).toBe(1_000);
    expect(cfg["queued.max.messages.kbytes"]).toBe(4_096);
  });

  it("honours operator overrides for offsets, commits and rebalance timeouts", async () => {
    await testCase("NB-805", "consumer overrides");
    const cfg = buildConsumerConfig(
      stub({
        KAFKA_CONSUMER_AUTO_OFFSET_RESET: "earliest",
        KAFKA_CONSUMER_ALLOW_AUTO_CREATE_TOPICS: "false",
        KAFKA_CONSUMER_ENABLE_AUTO_COMMIT: "true",
        KAFKA_CONSUMER_SESSION_TIMEOUT_MS: "30000",
        KAFKA_CONSUMER_MAX_POLL_INTERVAL_MS: "600000",
      }),
      "replay-group",
    );
    expect(cfg).toMatchObject({
      "auto.offset.reset": "earliest",
      "allow.auto.create.topics": false,
      "enable.auto.commit": true,
      "session.timeout.ms": 30_000,
      "max.poll.interval.ms": 600_000,
    });
  });

  it("uses an explicit client id suffix so broker-side metrics split per consumer", async () => {
    await testCase("NB-806", "consumer client.id suffix");
    const cfg = buildConsumerConfig(stub({ KAFKA_CLIENT_ID: "svc" }), "events", "event-consumer");
    expect(cfg["client.id"]).toBe("svc-event-consumer");
  });
});
