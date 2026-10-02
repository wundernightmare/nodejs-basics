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
 * Only what the application can act on — librdkafka reports hundreds of
 * fields, most of them broker internals better read from the broker:
 *
 *   both      kafka.client.brokers.up                 gauge    brokers in state UP
 *             kafka.client.request.errors             counter  {error.type: timeout|transmit|receive}
 *   producer  kafka.client.producer.queue.messages    gauge    messages waiting in the local queue
 *             kafka.client.producer.queue.size        gauge    bytes in it …
 *             kafka.client.producer.queue.size.limit  gauge    … and its bound (queue.buffering.max.kbytes)
 *             kafka.client.messages.sent              counter  messages delivered to brokers
 *             kafka.client.broker.rtt                 gauge    p99 request round trip per broker
 *   consumer  kafka.client.consumer.lag.max           gauge    worst assigned partition
 *             kafka.client.consumer.lag.sum           gauge    total over assigned partitions
 *             kafka.client.consumer.fetch_queue.size  gauge    prefetched bytes (queued.max.messages.kbytes bound)
 *             kafka.client.consumer.rebalances        counter
 *             kafka.client.messages.received          counter  messages fetched from brokers
 *
 * Cardinality is fixed: no series carries a topic or partition label, so a
 * client on hundreds of topics exports the same ~10 series as one on a
 * single topic (per-partition lag belongs to the broker side — Redpanda's
 * consumer-group metrics, kminion, Burrow — exported once, not per pod).
 * The statistics JSON itself still lists every topic and partition: ~2.4 MB
 * and ~5 ms of JSON.parse for 300 topics × 12 partitions, per interval —
 * raise KAFKA_STATISTICS_INTERVAL_MS for thousands of topics.
 *
 * A consumer's broker rtt is left out on purpose: it includes the fetch long
 * poll (fetch.wait.max.ms), so it measures the poll, not the network.
 * Every series carries `kafka.client.role`; a snapshot older than `maxAgeMs`
 * (the client stopped reporting — disconnected) is not observed.
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
export interface RdKafkaStats {
  msg_cnt?: number;
  msg_size?: number;
  msg_size_max?: number;
  txmsgs?: number;
  rxmsgs?: number;
  brokers?: Record<
    string,
    {
      nodeid?: number;
      nodename?: string;
      state?: string;
      req_timeouts?: number;
      txerrs?: number;
      rxerrs?: number;
      rtt?: { p99?: number };
    }
  >;
  topics?: Record<
    string,
    { partitions?: Record<string, { consumer_lag?: number; fetchq_size?: number }> }
  >;
  cgrp?: { rebalance_cnt?: number };
}

/** librdkafka hands the statistics over as `{ message: "<json>" }` (or the bare JSON). */
export function parseStats(event: unknown): RdKafkaStats | undefined {
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
  const instruments: Observable[] = [brokersUp, requestErrors];

  const queueMessages = meter.createObservableGauge("kafka.client.producer.queue.messages", {
    description: "Messages waiting in the producer's local queue (not yet acknowledged).",
    unit: "{message}",
  });
  const queueSize = meter.createObservableGauge("kafka.client.producer.queue.size", {
    description: "Bytes in the producer's local queue.",
    unit: "By",
  });
  const queueLimit = meter.createObservableGauge("kafka.client.producer.queue.size.limit", {
    description: "The local queue's bound (queue.buffering.max.kbytes); full → QUEUE_FULL.",
    unit: "By",
  });
  const sent = meter.createObservableCounter("kafka.client.messages.sent", {
    description: "Messages the producer delivered to brokers.",
    unit: "{message}",
  });
  const rtt = meter.createObservableGauge("kafka.client.broker.rtt", {
    description: "p99 request round-trip time per broker (producer).",
    unit: "ms",
  });

  const lagMax = meter.createObservableGauge("kafka.client.consumer.lag.max", {
    description: "Largest lag (messages behind the partition end) over the assigned partitions.",
    unit: "{message}",
  });
  const lagSum = meter.createObservableGauge("kafka.client.consumer.lag.sum", {
    description: "Total lag over the assigned partitions.",
    unit: "{message}",
  });
  const fetchQueue = meter.createObservableGauge("kafka.client.consumer.fetch_queue.size", {
    description: "Bytes prefetched and not yet handed to the application.",
    unit: "By",
  });
  const rebalances = meter.createObservableCounter("kafka.client.consumer.rebalances", {
    description: "Consumer group rebalances this client went through.",
    unit: "{rebalance}",
  });
  const received = meter.createObservableCounter("kafka.client.messages.received", {
    description: "Messages the consumer fetched from brokers.",
    unit: "{message}",
  });
  if (role === "producer") instruments.push(queueMessages, queueSize, queueLimit, sent, rtt);
  else instruments.push(lagMax, lagSum, fetchQueue, rebalances, received);

  let latest: RdKafkaStats | undefined;
  let receivedAt = 0;

  const observe = (result: BatchObservableResult): void => {
    const s = latest;
    if (s === undefined || now() - receivedAt > maxAgeMs) return;
    // Real brokers only: bootstrap and coordinator entries have nodeid -1.
    const brokers = Object.values(s.brokers ?? {}).filter((b) => (b.nodeid ?? -1) >= 0);
    result.observe(brokersUp, brokers.filter((b) => b.state === "UP").length, base);
    const sum = (pick: (b: (typeof brokers)[number]) => number | undefined): number =>
      brokers.reduce((n, b) => n + (pick(b) ?? 0), 0);
    result.observe(
      requestErrors,
      sum((b) => b.req_timeouts),
      {
        ...base,
        "error.type": "timeout",
      },
    );
    result.observe(
      requestErrors,
      sum((b) => b.txerrs),
      { ...base, "error.type": "transmit" },
    );
    result.observe(
      requestErrors,
      sum((b) => b.rxerrs),
      { ...base, "error.type": "receive" },
    );

    if (role === "producer") {
      result.observe(queueMessages, s.msg_cnt ?? 0, base);
      result.observe(queueSize, s.msg_size ?? 0, base);
      if (s.msg_size_max !== undefined) result.observe(queueLimit, s.msg_size_max, base);
      result.observe(sent, s.txmsgs ?? 0, base);
      for (const b of brokers) {
        // librdkafka reports microseconds; 0 until a request completed.
        const p99 = b.rtt?.p99 ?? 0;
        if (p99 > 0) {
          result.observe(rtt, p99 / 1000, { ...base, "kafka.broker.id": String(b.nodeid) });
        }
      }
      return;
    }

    let fetched = 0;
    let maxLag = 0;
    let sumLag = 0;
    for (const t of Object.values(s.topics ?? {})) {
      for (const [partition, p] of Object.entries(t.partitions ?? {})) {
        fetched += p.fetchq_size ?? 0;
        // -1: the internal UA partition, or a lag not known yet.
        const partitionLag = p.consumer_lag ?? -1;
        if (partition === "-1" || partitionLag < 0) continue;
        maxLag = Math.max(maxLag, partitionLag);
        sumLag += partitionLag;
      }
    }
    result.observe(lagMax, maxLag, base);
    result.observe(lagSum, sumLag, base);
    result.observe(fetchQueue, fetched, base);
    result.observe(rebalances, s.cgrp?.rebalance_cnt ?? 0, base);
    result.observe(received, s.rxmsgs ?? 0, base);
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
