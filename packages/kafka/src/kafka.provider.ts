import { KafkaJS } from "@confluentinc/kafka-javascript";
import { Global, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { AppLogger, ecsError } from "@base/logger";

import { buildKafkaClientConfig, buildProducerConfig } from "./kafka-config.builder.js";
import { kafkaLogger } from "./kafka-log-creator.js";
import { type KafkaClientMetrics, kafkaClientMetrics } from "./kafka-metrics.js";
import { sendTraced } from "./kafka-tracing.js";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** send() while the producer is not connected — retry later (the outbox does). */
export class KafkaNotConnectedError extends Error {
  constructor() {
    super("Kafka producer is not connected");
    this.name = "KafkaNotConnectedError";
  }
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
 *   - until connected, send() rejects with KafkaNotConnectedError at once —
 *     events go through the outbox, which keeps them and retries.
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

  /** Whether send() can deliver right now. */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * `producer.send` inside a PRODUCER span, with the trace context injected
   * into the record headers, so the consumer's span continues the caller's trace.
   */
  async send(record: KafkaJS.ProducerRecord): Promise<KafkaJS.RecordMetadata[]> {
    const producer = this.producer;
    if (!this.connected || producer === undefined) throw new KafkaNotConnectedError();
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
      kafkaJS: { allowAutoTopicCreation: false },
    });
  }

  private async connectWithRetry(): Promise<void> {
    if (this.stopped) return;
    const producer = this.createProducer();
    this.producer = producer;
    try {
      await producer.connect();
      if (this.stopped) {
        await producer.disconnect().catch(() => undefined);
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
    void broken.disconnect().catch(() => undefined);
    void this.connectWithRetry();
  }
}
