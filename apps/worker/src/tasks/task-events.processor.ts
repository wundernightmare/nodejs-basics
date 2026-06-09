/**
 * BullMQ worker that processes the jobs enqueued by TaskEventsConsumer — the
 * job-system half of the demo. "Processing" here just records a metric and
 * logs; a real worker would do the heavy/async work that should not block the
 * Kafka consumer (emails, webhooks, downstream calls).
 */
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { metrics } from "@opentelemetry/api";
import { type ConnectionOptions, type Job, Worker } from "bullmq";

import { BULLMQ_CONNECTION } from "@base/jobs";
import { AppLogger } from "@base/logger";

const QUEUE_NAME = "task-events";

@Injectable()
export class TaskEventsProcessor implements OnApplicationBootstrap, OnApplicationShutdown {
  private worker: Worker | undefined;
  private readonly logger: ReturnType<AppLogger["child"]>;
  private readonly processed = metrics
    .getMeter("worker")
    .createCounter("worker_tasks_processed_total", {
      description: "Task jobs processed successfully by the BullMQ worker.",
    });

  constructor(
    @Inject(BULLMQ_CONNECTION) private readonly connection: ConnectionOptions,
    appLogger: AppLogger,
  ) {
    this.logger = appLogger.child(TaskEventsProcessor.name);
  }

  onApplicationBootstrap(): void {
    this.worker = new Worker(
      QUEUE_NAME,
      async (job: Job): Promise<void> => {
        this.processed.add(1);
        this.logger.info(
          { "task.id": String(job.data.id), "job.id": job.id },
          "Task job processed",
        );
        await Promise.resolve();
      },
      { connection: this.connection },
    );
    this.logger.info({ "bullmq.queue": QUEUE_NAME }, "BullMQ worker started");
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }
}
