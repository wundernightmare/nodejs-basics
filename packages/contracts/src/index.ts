/**
 * @base/contracts — the TypeScript side of the contracts in api/tsp.
 *
 * Generated, never edited (`just contracts`):
 *   tasksapi.gen.ts  the HTTP contract, from api/openapi3/tasks.openapi.yaml
 *   events.gen.ts    the Kafka events, from api/jsonschema/*.json
 * This module names the types a producer, a consumer, a client or a test
 * reaches for, and createTasksClient (client.ts) — the typed client.
 */
export type { components, operations, paths } from "./tasksapi.gen.js";
export { createTasksClient, type TasksClient } from "./client.js";

import type { components } from "./tasksapi.gen.js";

type Schemas = components["schemas"];

/** A single to-do item (GET /tasks/{id}, and the body of every write). */
export type Task = Schemas["Task"];
/** Lifecycle state of a task. */
export type TaskStatus = Schemas["TaskStatus"];
/** One row of GET /tasks. */
export type TaskListItem = Schemas["TaskListItem"];
/** Body of GET /tasks. */
export type TaskListPage = Schemas["TaskListPage"];
/** Body of POST /tasks. */
export type CreateTask = Schemas["CreateTask"];
/** Body of PATCH /tasks/{id}. */
export type UpdateTask = Schemas["UpdateTask"];
/** Body of POST /tasks/{id}/archive. */
export type ArchiveTask = Schemas["ArchiveTask"];
/** RFC 9457 problem details — every error response. */
export type Problem = Schemas["Problem"];
/** Body of GET /health. */
export type HealthStatus = Schemas["HealthStatus"];

import type { components as events } from "./events.gen.js";

/** Kafka topic of the task lifecycle events (a topic is not part of a JSON Schema). */
export const TASK_EVENTS_TOPIC = "tasks.events";
/** Value of a `task.created` record on TASK_EVENTS_TOPIC; key = task id. */
export type TaskCreatedEvent = events["schemas"]["TaskCreatedEvent"];
