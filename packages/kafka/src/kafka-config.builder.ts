import { readFileSync } from "node:fs";

import type { ConfigService } from "@nestjs/config";

import { pinoLogger } from "@base/logger";

const kafkaLogger = pinoLogger.child({ "log.logger": "KafkaConfigBuilder" });

/**
 * Centralised Kafka client configuration.
 *
 * All Kafka clients in this process — the global producer (kafka.provider.ts)
 * and each consumer (modules/**\/*.consumer.ts) — funnel through this module
 * so that SASL credentials, TLS CA material, producer durability flags, and
 * consumer offset semantics are resolved from a single registry-backed env
 * surface (see infra/config/env.registry.ts — the KAFKA_* entries).
 *
 * The keys written into the returned objects are the raw librdkafka property
 * names (`security.protocol`, `sasl.mechanism`, `auto.offset.reset`, …) rather
 * than the confluentinc/kafka-javascript `kafkaJS` shortcut dialect. librdkafka
 * accepts both on the same constructor call, but using the raw names makes the
 * mapping from env.registry to runtime behaviour grep-able, and mirrors the
 * TOML layout the Rust edge services already use (worker-core's
 * KafkaSecurityConfig).
 *
 * Behaviour preserved for local dev / tests: when the security / tunable env
 * vars are unset the returned configs degrade to plaintext + librdkafka
 * defaults, so an untouched `localhost:9092` broker keeps working.
 */

// Narrow shape of @confluentinc/kafka-javascript's GlobalConfig that this
// module populates. Kept as `Record<string, unknown>` to avoid coupling the
// builder to a specific minor version of the library's ambient typings.
export type KafkaRdKafkaConfig = Record<string, unknown>;

const KAFKA_CA_PEM_FILE = "/tmp/kafka-ca.pem";

function readString(config: ConfigService, key: string): string | undefined {
  const v = config.get<string>(key);
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function readNumber(config: ConfigService, key: string): number | undefined {
  const raw = readString(config, key);
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function readBool(config: ConfigService, key: string): boolean | undefined {
  const raw = readString(config, key);
  if (raw === undefined) return undefined;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return undefined;
}

/**
 * Resolve the CA bundle path librdkafka should use.
 *
 * Prefers an explicit filesystem path (KAFKA_SSL_CA_LOCATION, typically a
 * ConfigMap/PVC mount). Falls back to an inline PEM (KAFKA_SSL_CA_PEM, typically
 * a Secret value injected via env) which is materialised on-disk once so
 * librdkafka's ssl.ca.location pointer stays valid for the lifetime of the
 * process. Returns undefined when neither is set — plaintext / cluster-trusted
 * deployments need no CA bundle.
 *
 * Side-effect (writing the temp file) runs lazily at first resolution so
 * import-time is side-effect-free.
 */
function resolveCaLocation(config: ConfigService): string | undefined {
  const explicit = readString(config, "KAFKA_SSL_CA_LOCATION");
  if (explicit) return explicit;

  const inline = readString(config, "KAFKA_SSL_CA_PEM");
  if (!inline) return undefined;

  // Lazy require keeps this module importable in environments without the
  // Node 'fs' module (e.g. browser test doubles). `writeFileSync` is safe to
  // call repeatedly — the contents are identical per boot.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  fs.writeFileSync(KAFKA_CA_PEM_FILE, inline, { encoding: "utf8", mode: 0o600 });
  return KAFKA_CA_PEM_FILE;
}

/**
 * Parse the KAFKA_EXTRA_PROPERTIES JSON escape hatch. Invalid JSON is ignored
 * with a thrown error at boot — silently swallowing it would make it impossible
 * to discover that a typo disabled a custom knob.
 */
function readExtraProperties(config: ConfigService): KafkaRdKafkaConfig {
  const raw = readString(config, "KAFKA_EXTRA_PROPERTIES");
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`KAFKA_EXTRA_PROPERTIES is not valid JSON: ${(err as Error).message}`, {
      cause: err,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("KAFKA_EXTRA_PROPERTIES must be a JSON object of librdkafka string properties");
  }
  return parsed as KafkaRdKafkaConfig;
}

/**
 * Connection-level properties common to every Kafka client built in this
 * process: broker list, client id (with an optional suffix so a pod's
 * producer + N consumers show up distinctly in broker metrics), security
 * protocol, SASL credentials, TLS CA, and socket-level timeouts.
 *
 * Producer- and consumer-specific tunables are added by the two builders
 * below, which spread this object first so the role-specific flags take
 * precedence on any accidental key collisions.
 */
export function buildKafkaClientConfig(
  config: ConfigService,
  clientIdSuffix?: string,
): KafkaRdKafkaConfig {
  const brokers = config.get<string>("KAFKA_BROKERS") ?? "localhost:9092";
  const clientId = config.get<string>("KAFKA_CLIENT_ID") ?? process.env["OTEL_SERVICE_NAME"] ?? "app";

  const out: KafkaRdKafkaConfig = {
    "metadata.broker.list": brokers,
    "client.id": clientIdSuffix ? `${clientId}-${clientIdSuffix}` : clientId,
  };

  // Security protocol — librdkafka is case-insensitive in practice, but the
  // ambient typings require lowercase; normalise so users can set SASL_SSL
  // or sasl_ssl interchangeably.
  const protocol = readString(config, "KAFKA_SECURITY_PROTOCOL")?.toLowerCase();
  if (protocol) out["security.protocol"] = protocol;

  // SASL mechanism stays uppercase — SCRAM-SHA-512 is the canonical form both
  // in librdkafka and in managed broker UIs.
  const mechanism = readString(config, "KAFKA_SASL_MECHANISM")?.toUpperCase();
  if (mechanism) out["sasl.mechanism"] = mechanism;

  const saslUser = readString(config, "KAFKA_SASL_USERNAME");
  if (saslUser) out["sasl.username"] = saslUser;

  // KAFKA_SASL_PASSWORD_FILE wins when set — same precedence as DATABASE_*.
  // librdkafka does NOT support credential rotation at runtime; the file
  // is read once at boot and the consumer/producer holds the value for
  // its lifetime. Operators pair this with Stakater Reloader (or a
  // manual `kubectl rollout restart`) to roll the secret on rotation.
  const saslPassFile = readString(config, "KAFKA_SASL_PASSWORD_FILE");
  let saslPass: string | undefined;
  if (saslPassFile) {
    try {
      saslPass = readFileSync(saslPassFile, "utf8").replace(/\r?\n+$/, "");
    } catch (err) {
      kafkaLogger.warn(
        { err, "kafka.sasl_password_file": saslPassFile },
        "KAFKA_SASL_PASSWORD_FILE could not be read — falling back to KAFKA_SASL_PASSWORD",
      );
    }
  }
  if (!saslPass) saslPass = readString(config, "KAFKA_SASL_PASSWORD");
  if (saslPass) out["sasl.password"] = saslPass;

  const caLocation = resolveCaLocation(config);
  if (caLocation) out["ssl.ca.location"] = caLocation;

  const endpointAlg = readString(config, "KAFKA_SSL_ENDPOINT_IDENTIFICATION_ALGORITHM");
  if (endpointAlg) out["ssl.endpoint.identification.algorithm"] = endpointAlg;

  // Socket / connection tunables — applied only when explicitly set so that
  // librdkafka's own defaults (30s request timeout, 5min metadata refresh,
  // 100ms reconnect backoff) remain the implicit fallback.
  const reqTimeout = readNumber(config, "KAFKA_REQUEST_TIMEOUT_MS");
  if (reqTimeout !== undefined) out["socket.timeout.ms"] = reqTimeout;

  const metadataAge = readNumber(config, "KAFKA_METADATA_MAX_AGE_MS");
  if (metadataAge !== undefined) out["topic.metadata.refresh.interval.ms"] = metadataAge;

  const reconnect = readNumber(config, "KAFKA_RECONNECT_BACKOFF_MS");
  if (reconnect !== undefined) out["reconnect.backoff.ms"] = reconnect;

  const reconnectMax = readNumber(config, "KAFKA_RECONNECT_BACKOFF_MAX_MS");
  if (reconnectMax !== undefined) out["reconnect.backoff.max.ms"] = reconnectMax;

  // Escape hatch is applied last so it can tune anything above on purpose.
  return { ...out, ...readExtraProperties(config) };
}

/**
 * Producer role flags: acks, idempotence, compression, linger, message
 * timeout. All default to safe money-downstream values (acks=all +
 * idempotence=true + zstd) so a fresh deployment loses records only when the
 * operator deliberately relaxes the knobs.
 */
export function buildProducerConfig(config: ConfigService): KafkaRdKafkaConfig {
  const base = buildKafkaClientConfig(config, "producer");

  const out: KafkaRdKafkaConfig = {
    ...base,
    acks: readString(config, "KAFKA_PRODUCER_ACKS") ?? "all",
    "enable.idempotence": readBool(config, "KAFKA_PRODUCER_ENABLE_IDEMPOTENCE") ?? true,
    "compression.type": readString(config, "KAFKA_PRODUCER_COMPRESSION_TYPE") ?? "zstd",
    "linger.ms": readNumber(config, "KAFKA_PRODUCER_LINGER_MS") ?? 10,
    "message.timeout.ms": readNumber(config, "KAFKA_PRODUCER_MESSAGE_TIMEOUT_MS") ?? 30_000,
  };
  // Re-apply the escape hatch so it wins over role flags too.
  return { ...out, ...readExtraProperties(config) };
}

/**
 * Consumer role flags: group id (per caller), offset-reset policy, explicit
 * commit by default (at-least-once semantics both control-plane consumers
 * rely on), and rebalance timeouts. Builders that need different defaults
 * per consumer still accept per-caller overrides via groupId — everything
 * else is process-scoped.
 */
export function buildConsumerConfig(
  config: ConfigService,
  groupId: string,
  clientIdSuffix?: string,
): KafkaRdKafkaConfig {
  const base = buildKafkaClientConfig(config, clientIdSuffix ?? `consumer-${groupId}`);

  const out: KafkaRdKafkaConfig = {
    ...base,
    "group.id": groupId,
    "auto.offset.reset": readString(config, "KAFKA_CONSUMER_AUTO_OFFSET_RESET") ?? "latest",
    "enable.auto.commit": readBool(config, "KAFKA_CONSUMER_ENABLE_AUTO_COMMIT") ?? false,
    "session.timeout.ms": readNumber(config, "KAFKA_CONSUMER_SESSION_TIMEOUT_MS") ?? 10_000,
    "max.poll.interval.ms": readNumber(config, "KAFKA_CONSUMER_MAX_POLL_INTERVAL_MS") ?? 300_000,
  };
  return { ...out, ...readExtraProperties(config) };
}
