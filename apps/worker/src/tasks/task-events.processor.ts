/**
 * Processes the jobs TaskEventsConsumer enqueues — the job-system half of the
 * demo, on BullMQ or pg-boss (@base/jobs JobsModule). "Processing" here just
 * records a metric and logs; a real worker would do the heavy/async work that
 * should not block the Kafka consumer (emails, webhooks, downstream calls).
 */
import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import { metrics } from "@opentelemetry/api";

import type { TaskCreatedEvent } from "@base/contracts";
import { type JobQueue, jobQueueToken } from "@base/jobs";
import { AppLogger } from "@base/logger";
import { ReadinessService } from "@base/observability";

import { TASK_JOBS } from "./task-events.consumer.js";

@Injectable()
export class TaskEventsProcessor implements OnApplicationBootstrap {
  private readonly logger: ReturnType<AppLogger["child"]>;
  // Prometheus-style name on purpose (pairs with worker_tasks_consumed_total);
  // see the note in task-events.consumer.ts.
  private readonly processed = metrics
    .getMeter("worker")
    .createCounter("worker_tasks_processed_total", {
      description: "Task jobs processed successfully by the job worker.",
    });

  constructor(
    @Inject(jobQueueToken(TASK_JOBS)) private readonly queue: JobQueue<TaskCreatedEvent>,
    appLogger: AppLogger,
    readiness: ReadinessService,
  ) {
    this.logger = appLogger.child(TaskEventsProcessor.name);
    // Critical: the job queue is the hand-off point.
    readiness.register({
      name: "jobs",
      check: async () => {
        await this.queue.ping();
        return "ok";
      },
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.work((event) => {
      this.processed.add(1);
      this.logger.info({ "task.id": event.id }, "Task job processed");
      return Promise.resolve();
    });
    this.logger.info({ "jobs.queue": TASK_JOBS }, "Job worker started");
  }
}
