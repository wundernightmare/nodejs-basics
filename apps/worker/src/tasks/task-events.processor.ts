/**
 * Processes the jobs TaskEventsConsumer enqueues — the job-system half of the
 * demo, on BullMQ or pg-boss (@base/jobs JobsModule). "Processing" here just
 * logs (each run is counted by the queue: job_runs_total); a real worker would do the heavy/async work that
 * should not block the Kafka consumer (emails, webhooks, downstream calls).
 */
import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";

import type { TaskCreatedEvent } from "@base/contracts";
import { type JobQueue, jobQueueToken } from "@base/jobs";
import { AppLogger } from "@base/logger";
import { ReadinessService } from "@base/observability";

import { TASK_JOBS } from "./task-events.consumer.js";

@Injectable()
export class TaskEventsProcessor implements OnApplicationBootstrap {
  private readonly logger: ReturnType<AppLogger["child"]>;

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
      this.logger.info({ "task.id": event.id }, "Task job processed");
      return Promise.resolve();
    });
    this.logger.info({ "jobs.queue": TASK_JOBS }, "Job worker started");
  }
}
