import { KafkaJS } from "@confluentinc/kafka-javascript";
import { Global, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { AppLogger, ecsError } from "@base/logger";

import { buildKafkaClientConfig, buildProducerConfig } from "./kafka-config.builder.js";
import { kafkaLogger } from "./kafka-log-creator.js";
import { registerKafkaMetrics, type KafkaMetricsHandle } from "./kafka-metrics.js";

export const KAFKA_PRODUCER = Symbol("KAFKA_PRODUCER");

/**
 * Provides a connected KafkaJS producer shared across the application.
 *
 * Lifecycle:
 *   onApplicationBootstrap → producer.connect()
 *   onApplicationShutdown  → producer.disconnect()
 *
 * If Kafka is unreachable at startup the connection error is logged but the
 * application continues — config events are best-effort; the hourly S3 snapshot
 * is the authoritative source of truth for ingest services.
 */
@Injectable()
@Global()
export class KafkaProducerService implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly producer: KafkaJS.Producer;
  private readonly logger: ReturnType<AppLogger["child"]>;
  private readonly metricsHandle: KafkaMetricsHandle;

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
    this.producer = kafka.producer({
      ...buildProducerConfig(config),
      kafkaJS: { allowAutoTopicCreation: false },
    });
    this.metricsHandle = registerKafkaMetrics(this.producer, {
      role: "producer",
      client_id: process.env["OTEL_SERVICE_NAME"] ?? "app",
    });
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
      // Non-fatal: config events are best-effort; S3 snapshot is authoritative.
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
      this.metricsHandle.dispose();
    }
  }
}
