import { Module } from "@nestjs/common";

import { BullMQModule } from "@base/jobs";

import { TaskEventsConsumer } from "./task-events.consumer.js";
import { TaskEventsProcessor } from "./task-events.processor.js";

/**
 * Wires the Kafka consumer + the BullMQ processor over a single `task-events`
 * queue. BullMQModule.forQueues provides the Queue under bullmqQueueToken.
 */
@Module({
  imports: [BullMQModule.forQueues([{ name: "task-events" }])],
  providers: [TaskEventsConsumer, TaskEventsProcessor],
})
export class TaskEventsModule {}
