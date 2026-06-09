/**
 * Task domain events published to Kafka. The wire contract decoded by
 * apps/worker; keep it backwards-compatible. The topic name is shared by the
 * producer (here) and the consumer (apps/worker, which duplicates the shape so
 * the two services stay decoupled).
 */

/** Kafka topic the task lifecycle events are published to. */
export const TASK_EVENTS_TOPIC = "tasks.events";

/** Emitted after a task row is committed (best-effort, after the transaction). */
export interface TaskCreatedEvent {
  type: "task.created";
  id: string;
  title: string;
  createdAt: string;
}
