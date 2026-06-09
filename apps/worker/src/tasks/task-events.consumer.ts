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

import { bullmqQueueToken } from "@base/jobs";
import { buildConsumerConfig, kafkaLogger } from "@base/kafka";
import { AppLogger, ecsError } from "@base/logger";

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
  private readonly consumed = metrics
    .getMeter("worker")
    .createCounter("worker_tasks_consumed_total", {
      description: "task.created events consumed from Kafka and enqueued.",
    });

  constructor(
    private readonly config: ConfigService,
    @Inject(bullmqQueueToken("task-events")) private readonly queue: Queue,
    appLogger: AppLogger,
  ) {
    this.logger = appLogger.child(TaskEventsConsumer.name);
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
        eachMessage: async ({ message }) => {
          await this.handle(message.value);
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
    await this.queue.add("process-task", event, { jobId: event.id });
    this.logger.info({ "task.id": event.id }, "task.created consumed → enqueued");
  }

  async onApplicationShutdown(): Promise<void> {
    await this.consumer?.disconnect();
  }
}
