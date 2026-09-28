/**
 * Drains the `tasks.events` Kafka topic (produced by apps/api) and, for each
 * `task.created` event, enqueues a BullMQ job — demonstrating the Kafka
 * consumer + the hand-off to the job system. The TaskEventsProcessor handles
 * the enqueued job.
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

import { addTraced, bullmqQueueToken } from "@base/jobs";
import { buildConsumerConfig, kafkaLogger, traceKafkaMessage } from "@base/kafka";
import {
  AppLogger,
  ecsError,
  generateRequestId,
  isValidRequestId,
  withDebugLogging,
  withRequestId,
} from "@base/logger";
import { ReadinessService } from "@base/observability";

/** Topic + group — the consumer's local copy of the wire contract (decoupled). */
const TASK_EVENTS_TOPIC = "tasks.events";
const GROUP_ID = "tasks-worker";

interface TaskCreatedEvent {
  type?: string;
  id: string;
  title: string;
  createdAt: string;
}

@Injectable()
export class TaskEventsConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private consumer: KafkaJS.Consumer | undefined;
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

  async onApplicationBootstrap(): Promise<void> {
    const rdkafka = buildConsumerConfig(this.config, GROUP_ID, "worker");
    const kafka = new KafkaJS.Kafka({
      ...rdkafka,
      kafkaJS: { logger: kafkaLogger } as KafkaJS.KafkaConfig,
    });
    this.consumer = kafka.consumer({ ...rdkafka });

    try {
      // Ensure the topic exists before consuming/producing — the shared
      // producer runs with allowAutoTopicCreation:false, so nothing else
      // creates it. Idempotent: an already-existing topic is fine.
      await this.ensureTopic(kafka);
      await this.consumer.connect();
      await this.consumer.subscribe({ topics: [TASK_EVENTS_TOPIC] });
      await this.consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          // Correlate with the producing API request (x-request-id header) or
          // mint an id, so every log line of this message carries one. An
          // `x-debug-logging` header marks one message for debug logging. The
          // `process` span continues the producer's trace (traceparent header).
          const requestId = headerString(message.headers?.["x-request-id"]);
          const run = (): Promise<void> =>
            withRequestId(isValidRequestId(requestId) ? requestId : generateRequestId(), () =>
              this.handle(message.value),
            );
          await traceKafkaMessage({ topic, partition, message, group: GROUP_ID }, () =>
            message.headers?.["x-debug-logging"] !== undefined ? withDebugLogging(run) : run(),
          );
        },
      });
      this.logger.info(
        { "kafka.topic": TASK_EVENTS_TOPIC, "kafka.group": GROUP_ID },
        "Kafka consumer running",
      );
    } catch (err) {
      this.logger.warn(
        { ...ecsError(err as Error) },
        "Kafka consumer failed to start — events will be missed until reconnected",
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
    let event: TaskCreatedEvent;
    try {
      event = JSON.parse((value ?? Buffer.from("{}")).toString()) as TaskCreatedEvent;
    } catch (err) {
      this.logger.warn({ ...ecsError(err as Error) }, "Skipping undecodable event");
      return;
    }
    this.consumed.add(1);
    // Hand off to the job system; jobId = task id makes redelivery idempotent.
    // addTraced stores the trace context with the job for the processor.
    await addTraced(this.queue, "process-task", event, { jobId: event.id });
    this.logger.info({ "task.id": event.id }, "task.created consumed → enqueued");
  }

  async onApplicationShutdown(): Promise<void> {
    await this.consumer?.disconnect();
  }
}

function headerString(
  value: Buffer | string | (Buffer | string)[] | undefined,
): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined ? undefined : first.toString();
}
