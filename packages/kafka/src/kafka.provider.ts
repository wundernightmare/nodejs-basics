import { KafkaJS } from "@confluentinc/kafka-javascript";
import { Global, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { AppLogger, ecsError } from "@base/logger";

import { buildKafkaClientConfig, buildProducerConfig } from "./kafka-config.builder.js";
import { kafkaLogger } from "./kafka-log-creator.js";
import { type KafkaClientMetrics, kafkaClientMetrics } from "./kafka-metrics.js";
import { sendTraced } from "./kafka-tracing.js";

export const KAFKA_PRODUCER = Symbol("KAFKA_PRODUCER");

/**
 * Provides a connected KafkaJS producer shared across the application.
 *
 * Lifecycle:
 *   onApplicationBootstrap → producer.connect()
 *   onApplicationShutdown  → producer.disconnect()
 *
 * If Kafka is unreachable at startup the connection error is logged but the
 * application continues — events go through the outbox, so a broker that is
 * down only delays the relay.
 */
@Injectable()
@Global()
export class KafkaProducerService implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly producer: KafkaJS.Producer;
  private readonly logger: ReturnType<AppLogger["child"]>;
  private readonly clientMetrics: KafkaClientMetrics;

  constructor(config: ConfigService, appLogger: AppLogger) {
    this.logger = appLogger.child(KafkaProducerService.name);

    // Security (SASL/TLS) + socket tunables are resolved by the shared
    // builder so the producer and every consumer in this process stay in
    // lockstep with the KAFKA_* env.registry entries.
    // `kafkaJS.brokers` is typed as required, but the flat librdkafka config
    // above already carries `metadata.broker.list`; the runtime accepts the
    // mix, so we narrow the cast to the kafkaJS sub-block only.
    const kafka = new KafkaJS.Kafka({
      ...buildKafkaClientConfig(config, "producer"),
      kafkaJS: { logger: kafkaLogger } as KafkaJS.KafkaConfig,
    });
    // librdkafka statistics → kafka.client.* metrics (kafka-metrics.ts).
    this.clientMetrics = kafkaClientMetrics("producer");
    this.producer = kafka.producer({
      ...buildProducerConfig(config),
      stats_cb: this.clientMetrics.statsCb,
      kafkaJS: { allowAutoTopicCreation: false },
    });
  }

  /**
   * `producer.send` inside a PRODUCER span, with the trace context injected
   * into the record headers — use this rather than `producer.send` so the
   * consumer's span continues the caller's trace.
   */
  send(record: KafkaJS.ProducerRecord): Promise<KafkaJS.RecordMetadata[]> {
    return sendTraced(this.producer, record);
  }

  async onApplicationBootstrap(): Promise<void> {
    // Race against a 5 s deadline so a missing broker (local dev, no Kafka in deps.yml)
    // doesn't block the NestJS bootstrap chain for 2+ minutes.
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error("Kafka connect timed out after 5 s"));
      }, 5_000);
    });
    try {
      await Promise.race([this.producer.connect(), timeout]);
      this.logger.info("Kafka producer connected");
    } catch (err) {
      // Non-fatal: the outbox keeps the events until the broker is back.
      this.logger.warn(
        { ...ecsError(err as Error) },
        "Kafka producer failed to connect — events will be dropped until reconnected",
      );
    }
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.info({ "process.signal": signal ?? null }, "Kafka producer disconnecting");
    try {
      await this.producer.disconnect();
    } catch (err) {
      this.logger.warn({ ...ecsError(err as Error) }, "Kafka producer disconnect error");
    } finally {
      this.clientMetrics.dispose();
    }
  }
}
