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
 *   runner.assertRunning();    // a readiness check: connected and in its group
 *
 * Per message: the `x-request-id` header (or a fresh id) in the log context,
 * `x-debug-logging` turns on debug logging, a `process` span continues the
 * producer's trace. Then:
 *
 *   - `handle` resolves → the offset is committed: explicitly, offset + 1.
 *     `enable.auto.commit` is false and the kafkajs-compat layer only *stores*
 *     offsets, so without it a restart re-reads from the last commit (or
 *     from `auto.offset.reset`). A bare `commitOffsets()` inside eachMessage
 *     would commit the previous message (this one is stored only after
 *     eachMessage returns).
 *   - `handle` throws → not committed: the partition is paused, resumed after
 *     a per-partition backoff (1 s → 60 s), and the same message comes again.
 *     A bare throw would re-fetch at once — a hot loop. After
 *     KAFKA_CONSUMER_MAX_RETRIES retries the message is parked on the
 *     dead-letter topic (KAFKA_DEAD_LETTER_TOPIC, `{topic}.dlq`: key, value
 *     and headers as consumed plus `dlq_*` headers) through `producer`, then
 *     committed — one poison message costs its retries, not the partition.
 *     Without a producer, with `none`, or while the dead-letter send fails,
 *     it keeps its partition and is retried.
 *   - throw {@link KafkaBackpressureError} for "not now, the message is
 *     fine" (a full or unreachable downstream): backoff capped at 5 s, never
 *     counted towards the retries, never dead-lettered.
 *   - throw {@link KafkaPermanentError} for a message that can never succeed
 *     (undecodable, breaks the contract): dead-lettered without retries. Or
 *     return from `handle` to drop it (committed and skipped) when nobody
 *     will ever want it back.
 *
 * KAFKA_CONSUMER_PARTITIONS_CONCURRENTLY partitions are handled in parallel;
 * order within a partition (and so per key) holds.
 */
import { KafkaJS } from "@confluentinc/kafka-javascript";
import type { ConfigService } from "@nestjs/config";
import { metrics, type ObservableResult } from "@opentelemetry/api";

import { readInt, readString } from "@base/config";
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
import { KAFKA_LATENCY_BUCKETS_SECONDS, kafkaClientMetrics } from "./kafka-metrics.js";
import { traceKafkaMessage } from "./kafka-tracing.js";
import type { KafkaProducerService } from "./kafka.provider.js";
import { Reconnect } from "./reconnect.js";

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;
// Back-pressure clears on its own; a long pause would idle the consumer after it has.
const BACKPRESSURE_MAX_MS = 5_000;

// An error text can embed a whole payload; the dlq_error header keeps the start.
const MAX_DLQ_ERROR_CHARS = 1_024;
const DLQ_HEADERS = new Set([
  "dlq_reason", // "permanent" | "retries_exhausted"
  "dlq_error", // the last handler error, truncated
  "dlq_source_topic",
  "dlq_source_partition",
  "dlq_source_offset",
  "dlq_attempts", // handler invocations made
]);

/**
 * Thrown by a handler for "not now, the message is fine": a full downstream
 * queue (info log), or one that is down (pass the error as `cause`: warn
 * log). Paused and retried, backoff capped at 5 s, never dead-lettered.
 */
export class KafkaBackpressureError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "KafkaBackpressureError";
  }
}

/** Thrown by a handler for a message that can never succeed: dead-lettered at once. */
export class KafkaPermanentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "KafkaPermanentError";
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
  /** Sends what the consumer gives up on to the dead-letter topic; without it nothing is parked. */
  producer?: KafkaProducerService | undefined;
}

type Logger = ReturnType<AppLogger["child"]>;

export class KafkaConsumerRunner {
  private consumer: KafkaJS.Consumer | undefined;
  private running = false;
  /**
   * The group has handed this member its (possibly empty) assignment once.
   * Readiness waits for it: a member the broker keeps out of the group — an
   * eager member still holds it (INCONSISTENT_GROUP_PROTOCOL during a switch
   * to cooperative-sticky) — is running but consumes nothing.
   */
  private joined = false;
  private readonly failures = new Map<string, number>();
  /** Per partition: the message being retried and how often its handler failed. */
  private readonly attempts = new Map<string, { offset: string; failed: number; stuck: boolean }>();
  private readonly clientMetrics = kafkaClientMetrics("consumer");
  private readonly meter = metrics.getMeter("kafka");
  private readonly records = this.meter.createCounter("kafka_consumer_records_total", {
    description:
      "Records consumed, by topic and final outcome (ok, retried: ok after a failed attempt, dead_lettered, failed: given up on but not parked).",
  });
  private readonly handlerDuration = this.meter.createHistogram(
    "kafka_consumer_handler_duration_seconds",
    {
      description: "Duration of one handler attempt, by topic.",
      unit: "s",
      advice: { explicitBucketBoundaries: KAFKA_LATENCY_BUCKETS_SECONDS },
    },
  );
  private readonly commitErrors = this.meter.createCounter("kafka_consumer_commit_errors_total", {
    description: "Offset commits that failed (the message is handled; it may be redelivered).",
  });
  private readonly rebalances = this.meter.createCounter("kafka_consumer_rebalances_total", {
    description: "Group rebalance events for this member, by event (assigned, revoked, lost).",
  });
  private readonly assigned = this.meter.createObservableGauge(
    "kafka_consumer_assigned_partitions",
    { description: "Partitions currently assigned to this group member." },
  );
  private readonly observeAssigned = (result: ObservableResult): void => {
    if (!this.running || this.consumer === undefined) return;
    try {
      result.observe(this.consumer.assignment().length);
    } catch {
      // disconnected meanwhile
    }
  };
  private readonly concurrently: number;
  private readonly maxRetries: number;
  private readonly deadLetterTopic: string;
  /** The topics named in the subscription: the `topic` label's values (else `other`). */
  private readonly topics: ReadonlySet<string>;
  private readonly reconnect: Reconnect;

  constructor(
    private readonly config: ConfigService,
    private readonly logger: Logger,
    private readonly options: KafkaConsumerOptions,
  ) {
    this.concurrently = readInt(config, "KAFKA_CONSUMER_PARTITIONS_CONCURRENTLY");
    this.maxRetries = readInt(config, "KAFKA_CONSUMER_MAX_RETRIES");
    this.deadLetterTopic = readString(config, "KAFKA_DEAD_LETTER_TOPIC");
    this.topics = new Set(options.topics);
    this.assigned.addCallback(this.observeAssigned);
    this.commitErrors.add(0); // exported as 0 from the start, like a Prometheus counter
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
    if (!this.joined) throw new Error("consumer has not joined its group yet");
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
      this.joined = false;
      this.clientMetrics.dispose();
      this.assigned.removeCallback(this.observeAssigned);
    }
  }

  /** The topic as a label: one the subscription names, else `other` (a regex subscription). */
  private topicLabel(topic: string): string {
    return this.topics.has(topic) ? topic : "other";
  }

  /** One record through the loop above. Public for tests. */
  async handleMessage(payload: KafkaJS.EachMessagePayload): Promise<void> {
    const { topic, partition, message } = payload;
    const requestId = headerString(message.headers?.["x-request-id"]);
    const run = (): Promise<void> =>
      withRequestId(isValidRequestId(requestId) ? requestId : generateRequestId(), () =>
        this.options.handle(message, { topic, partition }),
      );
    const label = { topic: this.topicLabel(topic) };
    const started = performance.now();
    try {
      await traceKafkaMessage({ topic, partition, message, group: this.options.groupId }, () =>
        message.headers?.["x-debug-logging"] === undefined ? run() : withDebugLogging(run),
      );
    } catch (err) {
      this.handlerDuration.record((performance.now() - started) / 1000, label);
      const outcome = await this.giveUp(payload, err);
      if (outcome === "parked") {
        this.records.add(1, { ...label, result: "dead_lettered" });
        return; // parked and committed: move on
      }
      // Counted once, the first time the record is given up on; it is still
      // retried, holding its partition, until it can be parked or succeeds.
      if (outcome === "stuck") this.records.add(1, { ...label, result: "failed" });
      this.retryLater(payload, err);
      throw err;
    }
    this.handlerDuration.record((performance.now() - started) / 1000, label);
    const retried = this.failures.has(`${topic}:${partition}`);
    this.records.add(1, { ...label, result: retried ? "retried" : "ok" });
    await this.commit(topic, partition, message.offset);
  }

  /** Pause the partition; the same message comes again after the backoff. */
  private retryLater(payload: KafkaJS.EachMessagePayload, err: unknown): void {
    const { topic, partition, message } = payload;
    const key = `${topic}:${partition}`;
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
    if (backpressure && err.cause === undefined)
      this.logger.info(fields, "Back-pressure — partition paused");
    else if (backpressure) this.logger.warn(fields, "Downstream unavailable — partition paused");
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
  }

  /**
   * Parks the message on the dead-letter topic and commits it when its handler
   * failed for good (permanent, or past KAFKA_CONSUMER_MAX_RETRIES): "parked".
   * "retry": not given up on yet. "stuck": given up on, but it cannot be
   * parked (no dead-letter topic, or the send failed) — retried, holding its
   * partition; "still_stuck" on the attempts after that.
   */
  private async giveUp(
    payload: KafkaJS.EachMessagePayload,
    err: unknown,
  ): Promise<"parked" | "retry" | "stuck" | "still_stuck"> {
    if (err instanceof KafkaBackpressureError) return "retry";
    const { topic, partition, message } = payload;
    const key = `${topic}:${partition}`;
    const previous = this.attempts.get(key);
    const same = previous?.offset === message.offset ? previous : undefined;
    const failed = (same?.failed ?? 0) + 1;
    this.attempts.set(key, { offset: message.offset, failed, stuck: same?.stuck ?? false });
    const reason = err instanceof KafkaPermanentError ? "permanent" : "retries_exhausted";
    const producer = this.options.producer;
    if (reason === "retries_exhausted" && failed <= this.maxRetries) return "retry";
    if (producer === undefined || this.deadLetterTopic === "none") return this.markStuck(key);

    const deadLetterTopic = this.deadLetterTopic.replaceAll("{topic}", topic);
    const error = (err instanceof Error ? err.message : String(err)).slice(0, MAX_DLQ_ERROR_CHARS);
    const headers: KafkaJS.IHeaders = {};
    for (const [name, value] of Object.entries(message.headers ?? {})) {
      // A message replayed from a dead-letter topic gets fresh ones.
      if (value !== undefined && !DLQ_HEADERS.has(name)) headers[name] = value;
    }
    Object.assign(headers, {
      dlq_reason: reason,
      dlq_error: error,
      dlq_source_topic: topic,
      dlq_source_partition: String(partition),
      dlq_source_offset: message.offset,
      dlq_attempts: String(failed),
    });
    try {
      await producer.send({
        topic: deadLetterTopic,
        messages: [{ key: message.key, value: message.value, headers }],
      });
    } catch (sendErr) {
      this.logger.warn(
        { ...ecsError(sendErr), "kafka.topic": topic, "kafka.dead_letter_topic": deadLetterTopic },
        "Could not dead-letter a message — it keeps its partition and is retried",
      );
      return this.markStuck(key);
    }
    this.logger.warn(
      {
        "event.action": "kafka.dead_lettered",
        "event.reason": reason,
        "error.message": error,
        "kafka.topic": topic,
        "kafka.partition": partition,
        "kafka.offset": message.offset,
        "kafka.dead_letter_topic": deadLetterTopic,
        "kafka.attempts": failed,
      },
      "Message dead-lettered",
    );
    await this.commit(topic, partition, message.offset);
    return "parked";
  }

  /** "stuck" the first time the partition's current message is given up on, then "still_stuck". */
  private markStuck(key: string): "stuck" | "still_stuck" {
    const entry = this.attempts.get(key);
    if (entry === undefined || entry.stuck) return "still_stuck";
    entry.stuck = true;
    return "stuck";
  }

  private async commit(topic: string, partition: number, offset: string): Promise<void> {
    const key = `${topic}:${partition}`;
    this.failures.delete(key);
    this.attempts.delete(key);
    try {
      await this.consumer?.commitOffsets([
        { topic, partition, offset: (BigInt(offset) + 1n).toString() },
      ]);
    } catch (err) {
      // Not thrown: the message is handled; a redelivery is the cheaper failure.
      this.commitErrors.add(1);
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
    this.joined = false;
    const consumer = kafka.consumer({
      ...buildConsumerConfig(this.config, this.options.groupId),
      stats_cb: this.clientMetrics.statsCb,
      // Observes only (returns nothing): the compat layer still applies the
      // assignment. Called with an empty one too when the group has no
      // partition left for this member.
      rebalance_cb: (
        err: { code: number },
        _assignment: unknown,
        fns?: { assignmentLost?: () => boolean },
      ) => {
        if (err.code === KafkaJS.ErrorCodes.ERR__ASSIGN_PARTITIONS) {
          this.joined = true;
          this.rebalances.add(1, { event: "assigned" });
        } else if (err.code === KafkaJS.ErrorCodes.ERR__REVOKE_PARTITIONS) {
          this.rebalances.add(1, { event: fns?.assignmentLost?.() === true ? "lost" : "revoked" });
        }
      },
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
