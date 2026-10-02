/**
 * Drains the `tasks.events` Kafka topic (produced by apps/api) and, for each
 * `task.created` event (TaskCreatedEvent — generated from api/tsp/events.tsp,
 * the same type the producer writes), enqueues a BullMQ job — demonstrating the Kafka
 * consumer + the hand-off to the job system. The TaskEventsProcessor handles
 * the enqueued job.
 *
 * Delivery is at least once, and the offset is ours to move:
 *   • `enable.auto.commit` is false (@base/kafka) and the kafkajs-compat layer
 *     only *stores* an offset after `eachMessage` returns — nothing flushes the
 *     store. Without the explicit `commitOffsets()` a restarted worker resumes
 *     at the tail (`auto.offset.reset: latest`) and silently drops whatever
 *     was produced while it was down.
 *   • A throw from `eachMessage` makes the layer seek back and re-fetch at
 *     once — a busy loop while Valkey is down. So: pause the partition, resume
 *     it on a backoff timer, then throw.
 *   • A message that can never be handled (not JSON) is committed and skipped
 *     — retrying it would wedge the partition forever.
 */
import { KafkaJS } from "@confluentinc/kafka-javascript";
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { metrics } from "@opentelemetry/api";
import { type Queue } from "bullmq";

import { TASK_EVENTS_TOPIC, type TaskCreatedEvent } from "@base/contracts";
import { addTraced, bullmqQueueToken } from "@base/jobs";
import {
  buildConsumerConfig,
  buildKafkaClientConfig,
  kafkaClientMetrics,
  kafkaLogger,
  traceKafkaMessage,
} from "@base/kafka";
import {
  AppLogger,
  ecsError,
  generateRequestId,
  isValidRequestId,
  withDebugLogging,
  withRequestId,
} from "@base/logger";
import { ReadinessService } from "@base/observability";

const GROUP_ID = "tasks-worker";
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const PROCESS_RETRY_BASE_MS = 1_000;
const PROCESS_RETRY_MAX_MS = 60_000;

@Injectable()
export class TaskEventsConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private consumer: KafkaJS.Consumer | undefined;
  private stopped = false;
  private connected = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectDelayMs = RECONNECT_BASE_MS;
  // Consecutive failures per partition ("topic:partition"): with partitions
  // handled concurrently, one partition's backoff must not shape another's.
  private readonly processFailures = new Map<string, number>();
  // One metrics handle for the logical consumer; every reconnect attempt's
  // client reports into it (librdkafka statistics → kafka.client.*).
  private readonly clientMetrics = kafkaClientMetrics("consumer");
  private readonly partitionsConcurrently: number;
  private readonly logger: ReturnType<AppLogger["child"]>;
  // Prometheus-style name on purpose (e2e greps `worker_tasks_consumed_total`
  // and that is what dashboards expect); OTel semconv would spell it
  // `worker.tasks.consumed` with unit "{task}" and let the exporter add `_total`.
  private readonly consumed = metrics
    .getMeter("worker")
    .createCounter("worker_tasks_consumed_total", {
      description: "task.created events consumed from Kafka and enqueued.",
    });

  constructor(
    private readonly config: ConfigService,
    @Inject(bullmqQueueToken("task-events")) private readonly queue: Queue,
    appLogger: AppLogger,
    readiness: ReadinessService,
  ) {
    this.logger = appLogger.child(TaskEventsConsumer.name);
    const concurrently = Number(config.get<string>("KAFKA_CONSUMER_PARTITIONS_CONCURRENTLY"));
    this.partitionsConcurrently =
      Number.isInteger(concurrently) && concurrently > 0 ? concurrently : 1;
    // Critical: a worker that cannot consume is not ready. assignment() throws
    // unless the consumer is connected, which is exactly the cheap check we want.
    readiness.register({
      name: "kafka",
      check: async () => {
        if (this.consumer === undefined) throw new Error("consumer not started");
        this.consumer.assignment();
        return "ok";
      },
    });
  }

  onApplicationBootstrap(): void {
    // Not awaited: with no broker the worker still boots (readiness says
    // not_ready) and keeps trying in the background.
    void this.connectWithRetry();
  }

  /**
   * Connect + subscribe + run, retrying with exponential backoff until it
   * sticks or the app shuts down. Each attempt gets a fresh consumer — one
   * that failed half-way (connected, subscribe threw) cannot be connected again.
   */
  private async connectWithRetry(): Promise<void> {
    if (this.stopped) return;
    // The Kafka instance (and the admin client ensureTopic makes from it)
    // takes the shared client config only — consumer properties there make
    // librdkafka warn "is a consumer property" on every connect.
    const rdkafka = buildConsumerConfig(this.config, GROUP_ID, "worker");
    const kafka = new KafkaJS.Kafka({
      ...buildKafkaClientConfig(this.config, "worker"),
      kafkaJS: { logger: kafkaLogger } as KafkaJS.KafkaConfig,
    });
    const consumer = kafka.consumer({ ...rdkafka, stats_cb: this.clientMetrics.statsCb });
    this.consumer = consumer;

    try {
      // Ensure the topic exists before consuming/producing — the shared
      // producer runs with allowAutoTopicCreation:false, so nothing else
      // creates it. Idempotent: an already-existing topic is fine.
      await this.ensureTopic(kafka);
      // Not raced against a timer: a connect in flight (it waits up to 30 s
      // for metadata) must settle before the client can be dropped — a
      // disconnect() under it makes the late "ready" throw from an event
      // handler and takes the process down. A rejected connect leaves the
      // client disconnected; the next attempt uses a fresh one.
      await consumer.connect();
      if (this.stopped) {
        await consumer.disconnect().catch(() => {});
        return;
      }
      await consumer.subscribe({ topics: [TASK_EVENTS_TOPIC] });
      await consumer.run({
        // Partitions handled in parallel; order within a partition (and so
        // per key) still holds. 1 = strictly one message at a time.
        partitionsConsumedConcurrently: this.partitionsConcurrently,
        eachMessage: (payload) => this.handleMessage(payload),
      });
      this.connected = true;
      this.reconnectDelayMs = RECONNECT_BASE_MS;
      this.logger.info(
        { "kafka.topic": TASK_EVENTS_TOPIC, "kafka.group": GROUP_ID },
        "Kafka consumer running",
      );
    } catch (err) {
      await consumer.disconnect().catch(() => {});
      if (this.stopped) return;
      const delay = this.reconnectDelayMs;
      this.reconnectDelayMs = Math.min(delay * 2, RECONNECT_MAX_MS);
      this.logger.warn(
        { ...ecsError(err as Error), "retry.delay_ms": delay },
        "Kafka consumer failed to start — retrying",
      );
      this.reconnectTimer = setTimeout(() => void this.connectWithRetry(), delay);
    }
  }

  /** One record: correlate, trace, handle; commit on success, pause + throw on failure. */
  async handleMessage(payload: KafkaJS.EachMessagePayload): Promise<void> {
    const { topic, partition, message } = payload;
    // Correlate with the producing API request (x-request-id header) or
    // mint an id, so every log line of this message carries one. An
    // `x-debug-logging` header marks one message for debug logging. The
    // `process` span continues the producer's trace (traceparent header).
    const requestId = headerString(message.headers?.["x-request-id"]);
    const run = (): Promise<void> =>
      withRequestId(isValidRequestId(requestId) ? requestId : generateRequestId(), () =>
        this.handle(message.value),
      );
    try {
      await traceKafkaMessage({ topic, partition, message, group: GROUP_ID }, () =>
        message.headers?.["x-debug-logging"] !== undefined ? withDebugLogging(run) : run(),
      );
    } catch (err) {
      // Not committed: pause this partition so the redelivery is spaced out,
      // then throw so the layer seeks back to this exact offset.
      const failures = this.processFailures.get(`${topic}:${partition}`) ?? 0;
      const delay = Math.min(PROCESS_RETRY_BASE_MS * 2 ** failures, PROCESS_RETRY_MAX_MS);
      this.processFailures.set(`${topic}:${partition}`, failures + 1);
      this.logger.warn(
        {
          ...ecsError(err as Error),
          "kafka.topic": topic,
          "kafka.offset": message.offset,
          "retry.delay_ms": delay,
        },
        "Failed to handle event — partition paused, offset not committed",
      );
      const resume = payload.pause();
      setTimeout(() => {
        // The consumer may have disconnected meanwhile — resume() then throws,
        // and the pause died with it.
        try {
          resume();
        } catch {
          /* already disconnected */
        }
      }, delay).unref();
      throw err;
    }
    this.processFailures.delete(`${topic}:${partition}`);
    await this.commit(topic, partition, message.offset);
  }

  /**
   * The only thing that advances the group offset: the NEXT offset to read.
   * Explicit, because a bare `commitOffsets()` from inside eachMessage commits
   * what the layer stored so far — the previous message (it stores this one
   * only after eachMessage returns), so every restart would redeliver one.
   * A failure is logged, not thrown: the job is already enqueued and
   * redelivery is idempotent (jobId), whereas a throw would re-process a
   * message that succeeded.
   */
  private async commit(topic: string, partition: number, offset: string): Promise<void> {
    try {
      await this.consumer?.commitOffsets([
        { topic, partition, offset: (BigInt(offset) + 1n).toString() },
      ]);
    } catch (err) {
      this.logger.warn(
        { ...ecsError(err as Error), "kafka.topic": TASK_EVENTS_TOPIC },
        "Failed to commit offset — redelivery is idempotent",
      );
    }
  }

  private async ensureTopic(kafka: KafkaJS.Kafka): Promise<void> {
    const admin = kafka.admin();
    try {
      await admin.connect();
      await admin.createTopics({ topics: [{ topic: TASK_EVENTS_TOPIC, numPartitions: 1 }] });
      this.logger.info({ "kafka.topic": TASK_EVENTS_TOPIC }, "Ensured Kafka topic exists");
    } catch (err) {
      // TOPIC_ALREADY_EXISTS (and races with another instance) are expected.
      this.logger.info(
        { ...ecsError(err as Error), "kafka.topic": TASK_EVENTS_TOPIC },
        "Topic create skipped (already exists?)",
      );
    } finally {
      await admin.disconnect();
    }
  }

  private async handle(value: Buffer | null): Promise<void> {
    let decoded: unknown;
    try {
      decoded = JSON.parse((value ?? Buffer.from("{}")).toString());
    } catch (err) {
      this.logger.warn({ ...ecsError(err as Error) }, "Skipping undecodable event");
      return;
    }
    // The topic may carry other event types (additive contract): not ours, skip.
    if (typeof decoded !== "object" || decoded === null) return;
    const event = decoded as TaskCreatedEvent;
    if (event.type !== "task.created") return;
    this.consumed.add(1);
    // Hand off to the job system; jobId = task id makes redelivery idempotent.
    // addTraced stores the trace context with the job for the processor.
    await addTraced(this.queue, "process-task", event, { jobId: event.id });
    this.logger.info({ "task.id": event.id }, "task.created consumed → enqueued");
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    try {
      // Only a running consumer is disconnected: one still connecting is left
      // to its metadata timeout (see connectWithRetry) — Nest ends the process.
      if (this.connected) await this.consumer?.disconnect();
    } catch (err) {
      this.logger.warn({ ...ecsError(err as Error) }, "Kafka consumer disconnect failed");
    } finally {
      this.clientMetrics.dispose();
    }
  }
}

function headerString(
  value: Buffer | string | (Buffer | string)[] | undefined,
): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined ? undefined : first.toString();
}
