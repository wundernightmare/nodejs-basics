/**
 * OpenTelemetry client metrics for @confluentinc/kafka-javascript, fed by
 * librdkafka's own statistics (`statistics.interval.ms`, set by
 * kafka-config.builder.ts). The kafkajs-compat clients have no event surface
 * to listen on, but they take a `stats_cb` in their config: pass
 * `metrics.statsCb` there.
 *
 *   const m = kafkaClientMetrics("producer");
 *   kafka.producer({ ...buildProducerConfig(config), stats_cb: m.statsCb });
 *   …on shutdown: m.dispose();
 *
 * Only what an alert is built on — librdkafka reports hundreds of fields:
 *
 *   both      kafka.client.brokers.up                 gauge    brokers in state UP
 *             kafka.client.request.errors             counter  timeouts + transmit/receive errors
 *   producer  kafka.client.producer.queue.size        gauge    bytes in the local send queue …
 *             kafka.client.producer.queue.size.limit  gauge    … and its bound: full → QUEUE_FULL
 *   consumer  kafka.client.consumer.lag.max           gauge    worst assigned partition
 *             kafka.client.consumer.lag.sum           gauge    total over assigned partitions
 *             kafka.client.consumer.rebalances        counter
 *
 * Cardinality is fixed — no topic or partition label (per-partition lag is
 * the broker side's job: exported once, not per pod). The statistics JSON
 * still lists every topic and partition (~2.4 MB / ~5 ms to parse at 300
 * topics × 12 partitions): raise KAFKA_STATISTICS_INTERVAL_MS for thousands.
 * A snapshot older than `maxAgeMs` (the client stopped reporting) is not
 * observed.
 */
import {
  type Attributes,
  type BatchObservableResult,
  metrics,
  type Observable,
} from "@opentelemetry/api";

export type KafkaClientRole = "producer" | "consumer";

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
  topics?: Record<string, { partitions?: Record<string, { consumer_lag?: number }> }>;
  cgrp?: { rebalance_cnt?: number };
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

export function kafkaClientMetrics(
  role: KafkaClientRole,
  attrs: Attributes = {},
  opts: { maxAgeMs?: number; now?: () => number } = {},
): KafkaClientMetrics {
  const maxAgeMs = opts.maxAgeMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const meter = metrics.getMeter("kafka.client");
  const base: Attributes = { ...attrs, "kafka.client.role": role };

  const brokersUp = meter.createObservableGauge("kafka.client.brokers.up", {
    description: "Brokers this client has a connection in state UP to.",
    unit: "{broker}",
  });
  const requestErrors = meter.createObservableCounter("kafka.client.request.errors", {
    description: "Request timeouts and transmit/receive errors, summed over brokers.",
    unit: "{error}",
  });
  const queueSize = meter.createObservableGauge("kafka.client.producer.queue.size", {
    description: "Bytes in the producer's local send queue.",
    unit: "By",
  });
  const queueLimit = meter.createObservableGauge("kafka.client.producer.queue.size.limit", {
    description: "The local queue's bound (queue.buffering.max.kbytes); full → QUEUE_FULL.",
    unit: "By",
  });
  const lagMax = meter.createObservableGauge("kafka.client.consumer.lag.max", {
    description: "Largest lag (messages behind the partition end) over the assigned partitions.",
    unit: "{message}",
  });
  const lagSum = meter.createObservableGauge("kafka.client.consumer.lag.sum", {
    description: "Total lag over the assigned partitions.",
    unit: "{message}",
  });
  const rebalances = meter.createObservableCounter("kafka.client.consumer.rebalances", {
    description: "Consumer group rebalances this client went through.",
    unit: "{rebalance}",
  });
  const instruments: Observable[] =
    role === "producer"
      ? [brokersUp, requestErrors, queueSize, queueLimit]
      : [brokersUp, requestErrors, lagMax, lagSum, rebalances];

  let latest: RdKafkaStats | undefined;
  let receivedAt = 0;

  const observe = (result: BatchObservableResult): void => {
    const s = latest;
    if (s === undefined || now() - receivedAt > maxAgeMs) return;
    // Real brokers only: bootstrap and coordinator entries have nodeid -1.
    const brokers = Object.values(s.brokers ?? {}).filter((b) => (b.nodeid ?? -1) >= 0);
    result.observe(brokersUp, brokers.filter((b) => b.state === "UP").length, base);
    const errors = brokers.reduce(
      (n, b) => n + (b.req_timeouts ?? 0) + (b.txerrs ?? 0) + (b.rxerrs ?? 0),
      0,
    );
    result.observe(requestErrors, errors, base);

    if (role === "producer") {
      result.observe(queueSize, s.msg_size ?? 0, base);
      if (s.msg_size_max !== undefined) result.observe(queueLimit, s.msg_size_max, base);
      return;
    }
    let maxLag = 0;
    let sumLag = 0;
    for (const t of Object.values(s.topics ?? {})) {
      for (const [partition, p] of Object.entries(t.partitions ?? {})) {
        // -1: the internal UA partition, or a lag not known yet.
        const partitionLag = p.consumer_lag ?? -1;
        if (partition === "-1" || partitionLag < 0) continue;
        maxLag = Math.max(maxLag, partitionLag);
        sumLag += partitionLag;
      }
    }
    result.observe(lagMax, maxLag, base);
    result.observe(lagSum, sumLag, base);
    result.observe(rebalances, s.cgrp?.rebalance_cnt ?? 0, base);
  };
  meter.addBatchObservableCallback(observe, instruments);

  return {
    statsCb: (event: unknown): void => {
      const parsed = parseStats(event);
      if (parsed === undefined) return;
      latest = parsed;
      receivedAt = now();
    },
    dispose: (): void => {
      meter.removeBatchObservableCallback(observe, instruments);
    },
  };
}
