/**
 * Validators for the Kafka events, compiled from the generated JSON Schemas
 * (events.schemas.gen.ts) — a consumer checks a record against the contract
 * instead of casting it. Extra fields pass (the contract is additive).
 */
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import type { components } from "./events.gen.js";
import { eventSchemas } from "./events.schemas.gen.js";

const ajv = new Ajv2020({ strict: false });
addFormats.default(ajv);

/** Value of a `task.created` record on TASK_EVENTS_TOPIC; key = task id. */
export type TaskCreatedEvent = components["schemas"]["TaskCreatedEvent"];

/** True when `value` is a `task.created` event as the contract defines it. */
export const isTaskCreatedEvent = ajv.compile<TaskCreatedEvent>(eventSchemas.TaskCreatedEvent);
