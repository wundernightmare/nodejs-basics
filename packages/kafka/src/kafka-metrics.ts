/**
 * Kafka client-internal metrics for @confluentinc/kafka-javascript, fed by
 * librdkafka's own statistics (`statistics.interval.ms`, set by
 * kafka-config.builder.ts). The kafkajs-compat clients have no event surface
 * to listen on, but they take a `stats_cb` in their config: pass
 * `metrics.statsCb` there.
 *
 *   const m = kafkaClientMetrics("producer");
 *   kafka.producer({ ...buildProducerConfig(config), stats_cb: m.statsCb });
 *   …on shutdown: m.dispose();
 *
 * Only what this client alone can see — the names golang-basics' providers
 * export:
 *
 *   both      kafka_client_brokers_up{client}            brokers in state UP
 *             kafka_client_request_errors_total{client}  timeouts + transmit/receive errors
 *   producer  kafka_producer_queue_bytes                 bytes in the local send queue …
 *             kafka_producer_queue_max_bytes             … and its bound: full → queue_full
 *
 * Consumer lag is not here: it is the broker's number (Redpanda
 * /public_metrics with consumer-group metrics on, kafka-exporter / Burrow on
 * Kafka) — one series per group and partition from one place, not a guess
 * per pod that vanishes with the pod. What the app does with the records is
 * kafka_producer_records_total / kafka_consumer_records_total (the producer
 * service and the consumer runner).
 *
 * Cardinality is fixed — no topic or partition label. A client that stopped
 * reporting for `maxAgeMs` counts as connected to no broker
 * (kafka_client_brokers_up 0); the other series keep their last value — an
 * OTel gauge that is not observed is not removed from the exposition.
 */
import {
  type Attributes,
  type BatchObservableResult,
  metrics,
  type Observable,
} from "@opentelemetry/api";

export type KafkaClientRole = "producer" | "consumer";

/** Latency buckets (seconds) of the producer and consumer histograms: the shared set + 30, 60. */
export const KAFKA_LATENCY_BUCKETS_SECONDS = [
  0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
];

export interface KafkaClientMetrics {
  /** librdkafka's stats callback — pass as `stats_cb` in the client config. */
  statsCb: (event: unknown) => void;
  /** Stop observing (remove the callback from the meter). */
  dispose(): void;
}

/** The subset of librdkafka's statistics JSON read here (STATISTICS.md). */
interface RdKafkaStats {
  msg_size?: number;
  msg_size_max?: number;
  brokers?: Record<
    string,
    { nodeid?: number; state?: string; req_timeouts?: number; txerrs?: number; rxerrs?: number }
  >;
}

/** librdkafka hands the statistics over as `{ message: "<json>" }` (or the bare JSON). */
function parseStats(event: unknown): RdKafkaStats | undefined {
  const raw =
    typeof event === "string"
      ? event
      : (event as { message?: unknown } | null | undefined)?.message;
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(raw) as RdKafkaStats;
  } catch {
    return undefined;
  }
}

type BrokerStats = NonNullable<RdKafkaStats["brokers"]>[string];

/** Real brokers only: bootstrap and coordinator entries have nodeid -1. */
function realBrokers(s: RdKafkaStats): [string, BrokerStats][] {
  return Object.entries(s.brokers ?? {}).filter(([, b]) => (b.nodeid ?? -1) >= 0);
}

export function kafkaClientMetrics(
  role: KafkaClientRole,
  opts: { maxAgeMs?: number; now?: () => number } = {},
): KafkaClientMetrics {
  const maxAgeMs = opts.maxAgeMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const meter = metrics.getMeter("kafka.client");
  const client: Attributes = { client: role };

  const brokersUp = meter.createObservableGauge("kafka_client_brokers_up", {
    description: "Brokers this client has a live connection (state UP) to.",
  });
  const requestErrors = meter.createObservableCounter("kafka_client_request_errors_total", {
    description: "Request timeouts and transmit/receive errors, summed over brokers.",
  });
  const queueBytes = meter.createObservableGauge("kafka_producer_queue_bytes", {
    description: "Bytes waiting in the producer's local send queue.",
    unit: "By",
  });
  const queueMaxBytes = meter.createObservableGauge("kafka_producer_queue_max_bytes", {
    description:
      "The local send queue's bound (KAFKA_PRODUCER_QUEUE_MAX_KBYTES); full → queue_full.",
    unit: "By",
  });
  const instruments: Observable[] =
    role === "producer"
      ? [brokersUp, requestErrors, queueBytes, queueMaxBytes]
      : [brokersUp, requestErrors];

  let latest: RdKafkaStats | undefined;
  let receivedAt = 0;
  // librdkafka's per-broker error counters restart when a broker entry is
  // recreated, and an entry that goes away takes its count with it: the sum
  // over the current entries can go down. The exported counter only ever
  // adds what each entry grew by since the last snapshot.
  let errorsTotal = 0;
  const lastErrors = new Map<string, number>();

  const observe = (result: BatchObservableResult): void => {
    const s = latest;
    if (s === undefined) return;
    if (now() - receivedAt > maxAgeMs) {
      result.observe(brokersUp, 0, client);
      return;
    }
    const brokers = realBrokers(s);
    result.observe(brokersUp, brokers.filter(([, b]) => b.state === "UP").length, client);
    result.observe(requestErrors, errorsTotal, client);
    if (role === "producer") {
      result.observe(queueBytes, s.msg_size ?? 0);
      if (s.msg_size_max !== undefined) result.observe(queueMaxBytes, s.msg_size_max);
    }
  };
  meter.addBatchObservableCallback(observe, instruments);

  return {
    statsCb: (event: unknown): void => {
      const parsed = parseStats(event);
      if (parsed === undefined) return;
      for (const [name, b] of realBrokers(parsed)) {
        const count = (b.req_timeouts ?? 0) + (b.txerrs ?? 0) + (b.rxerrs ?? 0);
        const previous = lastErrors.get(name) ?? 0;
        errorsTotal += count >= previous ? count - previous : count;
        lastErrors.set(name, count);
      }
      latest = parsed;
      receivedAt = now();
    },
    dispose: (): void => {
      meter.removeBatchObservableCallback(observe, instruments);
    },
  };
}
