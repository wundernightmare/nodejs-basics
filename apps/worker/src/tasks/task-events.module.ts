import { Module } from "@nestjs/common";

import { integrationEnabled } from "@base/config";
import { DatabaseModule } from "@base/database";
import { JobsModule } from "@base/jobs";

import { TASK_JOBS, TaskEventsConsumer } from "./task-events.consumer.js";
import { TaskEventsProcessor } from "./task-events.processor.js";

/**
 * The Kafka consumer and the job processor over one job queue — BullMQ when
 * VALKEY_URL is set, else pg-boss on Postgres (DATABASE_URL).
 */
@Module({
  imports: [
    ...(integrationEnabled("valkey") ? [] : [DatabaseModule]),
    JobsModule.forQueues([TASK_JOBS]),
  ],
  providers: [TaskEventsConsumer, TaskEventsProcessor],
})
export class TaskEventsModule {}
