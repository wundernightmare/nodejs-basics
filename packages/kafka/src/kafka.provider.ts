import { KafkaJS } from "@confluentinc/kafka-javascript";
import { Global, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { remainingMs } from "@base/common";
import { AppLogger, ecsError } from "@base/logger";

import { buildKafkaClientConfig, buildProducerConfig } from "./kafka-config.builder.js";
import { KafkaSendError, toKafkaSendError } from "./kafka-errors.js";
import { kafkaLogger } from "./kafka-log-creator.js";
import { type KafkaClientMetrics, kafkaClientMetrics } from "./kafka-metrics.js";
import { sendTraced } from "./kafka-tracing.js";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const DEFAULT_WAIT_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export interface KafkaSendOptions {
  /**
   * How long send() waits out local back-pressure before it throws:
   * `not_connected` (always) and `queue_full` (single-message records only —
   * see send()). Default 5000; capped by the request's deadline; 0 fails fast
   * (a caller with its own retry loop, like the outbox relay).
   */
  waitMs?: number;
}

/**
 * The application's Kafka producer. Use `send()` — it traces and propagates
 * the trace context — never a raw producer.
 *
 * Connection is the service's job, not the caller's:
 *   - bootstrap does not wait for the broker: connect runs in the background
 *     and retries with backoff (1 s → 30 s) until it sticks. A kafkajs-compat
 *     producer whose connect() failed can never connect again, so every
 *     attempt gets a fresh one.
 *   - a fatal librdkafka error (the idempotent producer's sequence state is
 *     broken) leaves the producer unusable; it is replaced the same way.
 *   - send() fails only with a KafkaSendError (kafka-errors.ts: the registry of
 *     kinds, which are retryable, and what to do about each).
 *   - shutdown never waits for a connect in flight: kafkajs-compat waits for
 *     its metadata request (up to 30 s) before it can disconnect, and Nest
 *     ends the process once the close hooks return.
 */
@Injectable()
@Global()
export class KafkaProducerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger: ReturnType<AppLogger["child"]>;
  private readonly clientMetrics: KafkaClientMetrics;
  private producer: KafkaJS.Producer | undefined;
  private connected = false;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectDelayMs = RECONNECT_BASE_MS;

  constructor(
    private readonly config: ConfigService,
    appLogger: AppLogger,
  ) {
    this.logger = appLogger.child(KafkaProducerService.name);
    // librdkafka statistics → kafka.client.* metrics (kafka-metrics.ts); one
    // handle for the logical producer, whichever client instance reports.
    this.clientMetrics = kafkaClientMetrics("producer");
  }

  /**
   * Send `record` inside a PRODUCER span, with the trace context injected into
   * the record headers so the consumer's span continues the caller's trace.
   *
   * Resolves once every message is acknowledged (acks=all). Rejects only with
   * a {@link KafkaSendError} — branch on `err.retryable`:
   *   - true: the record may succeed later; keep it and resend (the outbox does)
   *   - false: it never will (too large, invalid, unknown topic, no access)
   *
   * Short local back-pressure is waited out here, up to `options.waitMs`
   * (default 5 s, never past the request deadline), with backoff:
   *   - `not_connected` — nothing was enqueued, safe to wait for any record;
   *   - `queue_full` — only for a single-message record. The client enqueues
   *     a batch message by message, so on `queue_full` the first messages of
   *     a batch may already be on their way: a batch fails at once, and
   *     resending it can duplicate those (at-least-once, as everywhere).
   */
  async send(
    record: KafkaJS.ProducerRecord,
    options: KafkaSendOptions = {},
  ): Promise<KafkaJS.RecordMetadata[]> {
    const budget = Math.max(
      0,
      Math.min(options.waitMs ?? DEFAULT_WAIT_MS, remainingMs() ?? Infinity),
    );
    const until = Date.now() + budget;
    let delay = 50;
    for (;;) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- a retry loop: each attempt waits for the last
        return await this.sendOnce(record);
      } catch (err) {
        const error = toKafkaSendError(err);
        const waitable =
          error.kind === "not_connected" ||
          (error.kind === "queue_full" && record.messages.length === 1);
        const left = until - Date.now();
        if (!waitable || left <= 0) throw error;
        // oxlint-disable-next-line no-await-in-loop -- backoff between attempts
        await sleep(Math.min(delay, left));
        delay = Math.min(delay * 2, 1_000);
      }
    }
  }

  private async sendOnce(record: KafkaJS.ProducerRecord): Promise<KafkaJS.RecordMetadata[]> {
    const producer = this.producer;
    if (!this.connected || producer === undefined) throw new KafkaSendError("not_connected");
    try {
      return await sendTraced(producer, record);
    } catch (err) {
      if ((err as { fatal?: unknown }).fatal === true) this.replace(producer, err);
      throw err;
    }
  }

  onApplicationBootstrap(): void {
    void this.connectWithRetry();
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    const producer = this.producer;
    try {
      if (this.connected && producer !== undefined) {
        this.logger.info({ "process.signal": signal ?? null }, "Kafka producer disconnecting");
        this.connected = false;
        await producer.disconnect();
      }
    } catch (err) {
      this.logger.warn({ ...ecsError(err as Error) }, "Kafka producer disconnect error");
    } finally {
      this.clientMetrics.dispose();
    }
  }

  /** A new, unconnected producer. Protected so a test can substitute a fake. */
  protected createProducer(): KafkaJS.Producer {
    // `kafkaJS.brokers` is typed as required, but the flat librdkafka config
    // already carries `metadata.broker.list`; the cast covers the kafkaJS block.
    const kafka = new KafkaJS.Kafka({
      ...buildKafkaClientConfig(this.config, "producer"),
      kafkaJS: { logger: kafkaLogger } as KafkaJS.KafkaConfig,
    });
    return kafka.producer({
      ...buildProducerConfig(this.config),
      stats_cb: this.clientMetrics.statsCb,
    });
  }

  private async connectWithRetry(): Promise<void> {
    if (this.stopped) return;
    const producer = this.createProducer();
    this.producer = producer;
    try {
      await producer.connect();
      if (this.stopped) {
        await producer.disconnect().catch(() => {});
        return;
      }
      this.connected = true;
      this.reconnectDelayMs = RECONNECT_BASE_MS;
      this.logger.info("Kafka producer connected");
    } catch (err) {
      if (this.stopped) return;
      const delay = this.reconnectDelayMs;
      this.reconnectDelayMs = Math.min(delay * 2, RECONNECT_MAX_MS);
      this.logger.warn(
        { ...ecsError(err as Error), "retry.delay_ms": delay },
        "Kafka producer failed to connect — retrying; the outbox holds events meanwhile",
      );
      this.reconnectTimer = setTimeout(() => void this.connectWithRetry(), delay);
    }
  }

  /** Drop a producer a fatal error broke and connect a fresh one. */
  private replace(broken: KafkaJS.Producer, err: unknown): void {
    if (this.producer !== broken || this.stopped) return;
    this.connected = false;
    this.logger.error(
      { ...ecsError(err as Error) },
      "Kafka producer hit a fatal error — replacing it",
    );
    void broken.disconnect().catch(() => {});
    void this.connectWithRetry();
  }
}
