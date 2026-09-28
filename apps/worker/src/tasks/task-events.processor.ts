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

import { BULLMQ_CONNECTION, traceJob } from "@base/jobs";
import { AppLogger } from "@base/logger";
import { ReadinessService } from "@base/observability";

const QUEUE_NAME = "task-events";

@Injectable()
export class TaskEventsProcessor implements OnApplicationBootstrap, OnApplicationShutdown {
  private worker: Worker | undefined;
  private readonly logger: ReturnType<AppLogger["child"]>;
  // Prometheus-style name on purpose (pairs with worker_tasks_consumed_total);
  // see the note in task-events.consumer.ts.
  private readonly processed = metrics
    .getMeter("worker")
    .createCounter("worker_tasks_processed_total", {
      description: "Task jobs processed successfully by the BullMQ worker.",
    });

  constructor(
    @Inject(BULLMQ_CONNECTION) private readonly connection: ConnectionOptions,
    appLogger: AppLogger,
    readiness: ReadinessService,
  ) {
    this.logger = appLogger.child(TaskEventsProcessor.name);
    // Critical: BullMQ is the hand-off point; PING the worker's own Valkey connection.
    readiness.register({
      name: "valkey",
      check: async () => {
        if (this.worker === undefined) throw new Error("worker not started");
        // bullmq types the client as its own IRedisClient; at runtime it is the
        // iovalkey/ioredis instance, which answers PING.
        const client = (await this.worker.backend.client) as unknown as { ping(): Promise<string> };
        await client.ping();
        return "ok";
      },
    });
  }

  onApplicationBootstrap(): void {
    this.worker = new Worker(
      QUEUE_NAME,
      // traceJob: a `process` span parented on the Kafka consumer's span.
      (job: Job): Promise<void> =>
        traceJob(job, async () => {
          this.processed.add(1);
          this.logger.info(
            { "task.id": String(job.data.id), "job.id": job.id },
            "Task job processed",
          );
          await Promise.resolve();
        }),
      { connection: this.connection },
    );
    this.logger.info({ "bullmq.queue": QUEUE_NAME }, "BullMQ worker started");
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }
}
