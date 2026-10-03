/**
 * KafkaConsumerRunner — the at-least-once consumer loop every consumer in the
 * app needs, so a service only writes `handle()`:
 *
 *   const runner = new KafkaConsumerRunner(config, logger, {
 *     groupId: "tasks-worker",
 *     topics: [TASK_EVENTS_TOPIC],
 *     handle: (message) => this.handle(message),
 *   });
 *   runner.start();            // onApplicationBootstrap — does not wait for the broker
 *   await runner.stop();       // onApplicationShutdown
 *   runner.assertRunning();    // a readiness check
 *
 * Per message: the `x-request-id` header (or a fresh id) in the log context,
 * `x-debug-logging` turns on debug logging, a `process` span continues the
 * producer's trace. Then:
 *
 *   - `handle` resolves → the offset is committed: explicitly, offset + 1.
 *     `enable.auto.commit` is false and the kafkajs-compat layer only *stores*
 *     offsets, so without it a restart resumes at the tail
 *     (`auto.offset.reset: latest`) and drops whatever came in meanwhile. A
 *     bare `commitOffsets()` inside eachMessage would commit the previous
 *     message (this one is stored only after eachMessage returns).
 *   - `handle` throws → not committed: the partition is paused, resumed after
 *     a per-partition backoff (1 s → 60 s), and the same message comes again.
 *     A bare throw would re-fetch at once — a hot loop. Throw
 *     {@link KafkaBackpressureError} for "not now" (a full downstream queue):
 *     backoff capped at 5 s, logged at info.
 *   - a message that can never succeed (undecodable): return from `handle` —
 *     it is committed and skipped; throwing would wedge the partition.
 *
 * KAFKA_CONSUMER_PARTITIONS_CONCURRENTLY partitions are handled in parallel;
 * order within a partition (and so per key) holds.
 */
import { KafkaJS } from "@confluentinc/kafka-javascript";
import type { ConfigService } from "@nestjs/config";

import { readInt } from "@base/config";
import {
  type AppLogger,
  ecsError,
  generateRequestId,
  isValidRequestId,
  withDebugLogging,
  withRequestId,
} from "@base/logger";

import { buildConsumerConfig, buildKafkaClientConfig } from "./kafka-config.builder.js";
import { kafkaLogger } from "./kafka-log-creator.js";
import { kafkaClientMetrics } from "./kafka-metrics.js";
import { traceKafkaMessage } from "./kafka-tracing.js";
import { Reconnect } from "./reconnect.js";

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;
// Back-pressure clears on its own; a long pause would idle the consumer after it has.
const BACKPRESSURE_MAX_MS = 5_000;

/** Thrown by a handler for "not now": paused and retried, backoff capped at 5 s, info log. */
export class KafkaBackpressureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KafkaBackpressureError";
  }
}

export interface KafkaConsumerOptions {
  groupId: string;
  topics: string[];
  /** Resolve = done (committed); throw = retry the same message later. */
  handle: (
    message: KafkaJS.KafkaMessage,
    from: { topic: string; partition: number },
  ) => Promise<void>;
}

type Logger = ReturnType<AppLogger["child"]>;

export class KafkaConsumerRunner {
  private consumer: KafkaJS.Consumer | undefined;
  private running = false;
  private readonly failures = new Map<string, number>();
  private readonly clientMetrics = kafkaClientMetrics("consumer");
  private readonly concurrently: number;
  private readonly reconnect: Reconnect;

  constructor(
    private readonly config: ConfigService,
    private readonly logger: Logger,
    private readonly options: KafkaConsumerOptions,
  ) {
    this.concurrently = readInt(config, "KAFKA_CONSUMER_PARTITIONS_CONCURRENTLY") ?? 1;
    this.reconnect = new Reconnect(
      () => this.connect(),
      (err, delay) => {
        this.logger.warn(
          { ...ecsError(err), "retry.delay_ms": delay },
          "Kafka consumer failed to start — retrying",
        );
      },
    );
  }

  /** Connects in the background, retrying until it sticks. */
  start(): void {
    this.reconnect.start();
  }

  /** Throws unless the consumer is connected and running — a readiness check. */
  assertRunning(): void {
    if (!this.running || this.consumer === undefined) throw new Error("consumer not running");
    this.consumer.assignment();
  }

  async stop(): Promise<void> {
    this.reconnect.stop();
    try {
      // A consumer still connecting is left to its metadata timeout (see
      // Reconnect) — Nest ends the process once the close hooks return.
      if (this.running) await this.consumer?.disconnect();
    } catch (err) {
      this.logger.warn({ ...ecsError(err) }, "Kafka consumer disconnect failed");
    } finally {
      this.running = false;
      this.clientMetrics.dispose();
    }
  }

  /** One record through the loop above. Public for tests. */
  async handleMessage(payload: KafkaJS.EachMessagePayload): Promise<void> {
    const { topic, partition, message } = payload;
    const key = `${topic}:${partition}`;
    const requestId = headerString(message.headers?.["x-request-id"]);
    const run = (): Promise<void> =>
      withRequestId(isValidRequestId(requestId) ? requestId : generateRequestId(), () =>
        this.options.handle(message, { topic, partition }),
      );
    try {
      await traceKafkaMessage({ topic, partition, message, group: this.options.groupId }, () =>
        message.headers?.["x-debug-logging"] === undefined ? run() : withDebugLogging(run),
      );
    } catch (err) {
      const failures = this.failures.get(key) ?? 0;
      this.failures.set(key, failures + 1);
      const backpressure = err instanceof KafkaBackpressureError;
      const delay = Math.min(
        RETRY_BASE_MS * 2 ** failures,
        backpressure ? BACKPRESSURE_MAX_MS : RETRY_MAX_MS,
      );
      const fields = {
        ...ecsError(err),
        "kafka.topic": topic,
        "kafka.offset": message.offset,
        "retry.delay_ms": delay,
      };
      if (backpressure) this.logger.info(fields, "Back-pressure — partition paused");
      else this.logger.warn(fields, "Failed to handle a message — partition paused, not committed");
      const resume = payload.pause();
      setTimeout(() => {
        // The consumer may have disconnected meanwhile; the pause died with it.
        try {
          resume();
        } catch {
          /* already disconnected */
        }
      }, delay).unref();
      throw err;
    }
    this.failures.delete(key);
    try {
      await this.consumer?.commitOffsets([
        { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
      ]);
    } catch (err) {
      // Not thrown: the message is handled; a redelivery is the cheaper failure.
      this.logger.warn({ ...ecsError(err), "kafka.topic": topic }, "Failed to commit an offset");
    }
  }

  private askForTopics(kafka: KafkaJS.Kafka): Promise<void> {
    return askForTopicsOn(kafka, this.options.topics, this.logger);
  }

  private async connect(): Promise<void> {
    // The Kafka instance takes the shared client config only — consumer
    // properties there make librdkafka warn on every connect.
    const kafka = new KafkaJS.Kafka({
      ...buildKafkaClientConfig(this.config, this.options.groupId),
      kafkaJS: { logger: kafkaLogger } as KafkaJS.KafkaConfig,
    });
    const consumer = kafka.consumer({
      ...buildConsumerConfig(this.config, this.options.groupId),
      stats_cb: this.clientMetrics.statsCb,
    });
    this.consumer = consumer;
    try {
      await this.askForTopics(kafka);
      await consumer.connect();
      if (this.reconnect.stopped) {
        await consumer.disconnect();
        return;
      }
      await consumer.subscribe({ topics: this.options.topics });
      await consumer.run({
        partitionsConsumedConcurrently: this.concurrently,
        eachMessage: (payload) => this.handleMessage(payload),
      });
    } catch (err) {
      await consumer.disconnect().catch(() => {});
      throw err;
    }
    this.running = true;
    this.logger.info(
      { "kafka.topics": this.options.topics, "kafka.group": this.options.groupId },
      "Kafka consumer running",
    );
  }
}

/**
 * Asks the broker for the topics before subscribing: a consumer subscribed
 * to a topic that does not exist yet notices it only at the next metadata
 * refresh (topic.metadata.refresh.interval.ms, 5 min) — on a fresh broker the
 * first events would wait that long. Whether a topic is created stays the
 * broker's call: a provisioned cluster answers "exists" or refuses, both fine.
 */
async function askForTopicsOn(
  kafka: KafkaJS.Kafka,
  topics: string[],
  logger: Logger,
): Promise<void> {
  const admin = kafka.admin();
  try {
    await admin.connect();
    await admin.createTopics({ topics: topics.map((topic) => ({ topic })) });
  } catch (err) {
    logger.debug(
      { ...ecsError(err), "kafka.topics": topics },
      "Topics not created (exist, or not allowed)",
    );
  } finally {
    await admin.disconnect().catch(() => {});
  }
}

function headerString(
  value: Buffer | string | (Buffer | string)[] | undefined,
): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined ? undefined : first.toString();
}
