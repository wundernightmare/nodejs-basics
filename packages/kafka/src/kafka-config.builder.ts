import { writeFileSync } from "node:fs";

import type { ConfigService } from "@nestjs/config";

import { readBool, readInt, readJson, readSecretFile, readString } from "@base/config";

/**
 * Centralised Kafka client configuration.
 *
 * All Kafka clients in this process — the global producer (kafka.provider.ts)
 * and each consumer (modules/**\/*.consumer.ts) — funnel through this module
 * so that SASL credentials, TLS CA material, producer durability flags, and
 * consumer offset semantics are resolved from a single registry-backed env
 * surface (see @base/config env.registry.ts — the KAFKA_* entries).
 *
 * The keys written into the returned objects are the raw librdkafka property
 * names (`security.protocol`, `sasl.mechanism`, `auto.offset.reset`, …) rather
 * than the confluentinc/kafka-javascript `kafkaJS` shortcut dialect. librdkafka
 * accepts both on the same constructor call, but using the raw names makes the
 * mapping from env.registry to runtime behaviour grep-able (and matches the
 * librdkafka docs a platform team hands out).
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

  // Safe to call repeatedly — the contents are identical per boot.
  writeFileSync(KAFKA_CA_PEM_FILE, inline, { encoding: "utf8", mode: 0o600 });
  return KAFKA_CA_PEM_FILE;
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
  // Set whenever Kafka is on — the loader checks it (@base/config integrations.ts).
  const brokers = readString(config, "KAFKA_BROKERS");
  if (brokers === undefined) throw new Error("KAFKA_BROKERS is not set: Kafka is off");
  const clientId =
    config.get<string>("KAFKA_CLIENT_ID") ?? process.env["OTEL_SERVICE_NAME"] ?? "app";

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

  // The mounted file wins; read once — a new password is a rollout restart.
  const saslPass =
    readSecretFile(config, "KAFKA_SASL_PASSWORD_FILE") ?? readString(config, "KAFKA_SASL_PASSWORD");
  if (saslPass) out["sasl.password"] = saslPass;

  const caLocation = resolveCaLocation(config);
  if (caLocation) out["ssl.ca.location"] = caLocation;

  const endpointAlg = readString(config, "KAFKA_SSL_ENDPOINT_IDENTIFICATION_ALGORITHM");
  if (endpointAlg) out["ssl.endpoint.identification.algorithm"] = endpointAlg;

  // Socket / connection tunables — applied only when explicitly set so that
  // librdkafka's own defaults (30s request timeout, 5min metadata refresh,
  // 100ms reconnect backoff) remain the implicit fallback.
  const reqTimeout = readInt(config, "KAFKA_REQUEST_TIMEOUT_MS");
  if (reqTimeout !== undefined) out["socket.timeout.ms"] = reqTimeout;

  const metadataAge = readInt(config, "KAFKA_METADATA_MAX_AGE_MS");
  if (metadataAge !== undefined) out["topic.metadata.refresh.interval.ms"] = metadataAge;

  const reconnect = readInt(config, "KAFKA_RECONNECT_BACKOFF_MS");
  if (reconnect !== undefined) out["reconnect.backoff.ms"] = reconnect;

  const reconnectMax = readInt(config, "KAFKA_RECONNECT_BACKOFF_MAX_MS");
  if (reconnectMax !== undefined) out["reconnect.backoff.max.ms"] = reconnectMax;

  // TCP keepalive on: cloud load balancers and NAT gateways drop idle
  // connections silently, and a producer that only finds out on its next
  // send pays a full request timeout first.
  out["socket.keepalive.enable"] = true;

  // librdkafka statistics (JSON every N ms) feed the client metrics — see
  // kafka-metrics.ts. 0 turns them off.
  out["statistics.interval.ms"] = readInt(config, "KAFKA_STATISTICS_INTERVAL_MS");

  // Escape hatch is applied last so it can tune anything above on purpose.
  return { ...out, ...readJson(config, "KAFKA_EXTRA_PROPERTIES") };
}

/**
 * Producer role flags: acks, idempotence, compression, linger, message
 * timeout, local queue bound. Durable by default (acks=all + idempotence) so a
 * fresh deployment loses records only when the operator deliberately relaxes
 * the knobs; lz4 because it is the cheapest codec in CPU and latency at a
 * ratio close enough for event payloads (zstd for bandwidth-bound links).
 */
export function buildProducerConfig(config: ConfigService): KafkaRdKafkaConfig {
  const base = buildKafkaClientConfig(config, "producer");

  const out: KafkaRdKafkaConfig = {
    ...base,
    acks: readString(config, "KAFKA_PRODUCER_ACKS"),
    "enable.idempotence": readBool(config, "KAFKA_PRODUCER_ENABLE_IDEMPOTENCE"),
    "compression.type": readString(config, "KAFKA_PRODUCER_COMPRESSION_TYPE"),
    "linger.ms": readInt(config, "KAFKA_PRODUCER_LINGER_MS"),
    "message.timeout.ms": readInt(config, "KAFKA_PRODUCER_MESSAGE_TIMEOUT_MS"),
    // The local send queue. librdkafka's default holds up to 1 GiB per
    // producer: with the broker down and acks=all, that is where the pod's
    // memory goes. 64 MiB bounds it; a full queue fails send() with
    // QUEUE_FULL — the outbox relay rolls the batch back and retries later.
    "queue.buffering.max.kbytes": readInt(config, "KAFKA_PRODUCER_QUEUE_MAX_KBYTES"),
  };
  // Re-apply the escape hatches so they win over role flags too: the shared
  // one, then the producer-only one.
  return {
    ...out,
    ...readJson(config, "KAFKA_EXTRA_PROPERTIES"),
    ...readJson(config, "KAFKA_PRODUCER_EXTRA_PROPERTIES"),
  };
}

/**
 * Consumer role flags: group id (per caller), offset-reset policy, explicit
 * commit by default (at-least-once semantics: an event is committed only once
 * it is handled), and rebalance timeouts. Builders that need different defaults
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
    "auto.offset.reset": readString(config, "KAFKA_CONSUMER_AUTO_OFFSET_RESET"),
    // Topics are the broker's call: a dev broker auto-creates them
    // (docker/deps.yml), a provisioned cluster refuses — so the client may
    // always ask. Without it a consumer that subscribes before the first
    // message sits on an empty assignment until the next metadata refresh.
    "allow.auto.create.topics": true,
    "enable.auto.commit": readBool(config, "KAFKA_CONSUMER_ENABLE_AUTO_COMMIT"),
    "session.timeout.ms": readInt(config, "KAFKA_CONSUMER_SESSION_TIMEOUT_MS"),
    "max.poll.interval.ms": readInt(config, "KAFKA_CONSUMER_MAX_POLL_INTERVAL_MS"),
    // Bounded prefetch. librdkafka's defaults size the local queue for raw
    // throughput (100k messages, up to 64 MiB per partition): a consumer that
    // handles one message at a time and wakes up to a deep backlog pulls
    // hundreds of MB in faster than it drains them and is OOM-killed before
    // its first commit — a crash loop. Tune via KAFKA_CONSUMER_EXTRA_PROPERTIES.
    "queued.min.messages": 1_000,
    "queued.max.messages.kbytes": 4_096,
  };
  return {
    ...out,
    ...readJson(config, "KAFKA_EXTRA_PROPERTIES"),
    ...readJson(config, "KAFKA_CONSUMER_EXTRA_PROPERTIES"),
  };
}
