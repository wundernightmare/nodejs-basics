/**
 * A typed client of the tasks API: openapi-fetch over the generated `paths`,
 * so a path, a parameter or a body that is not in the contract does not
 * compile, and every response is typed by its status.
 *
 *   const api = createTasksClient({ baseUrl: "http://tasks:3000" });
 *   const { data, error } = await api.POST("/tasks", { body: { title: "hi" } });
 *
 * The transport is any fetch. Inside a service, give it the resilient one —
 * retries, circuit breaker, the request id and the request budget
 * (x-request-timeout-ms, cancellation) come with it:
 *
 *   createTasksClient({
 *     baseUrl,
 *     fetch: resilientFetch(new ResilientClient(baseUrl, {
 *       passthrough4xx: true, getRequestId, getRemainingMs: remainingMs,
 *     })),
 *   });
 */
import createClient, { type Client, type ClientOptions } from "openapi-fetch";

import type { paths } from "./tasksapi.gen.js";

export type TasksClient = Client<paths>;

export function createTasksClient(options: ClientOptions & { baseUrl: string }): TasksClient {
  return createClient<paths>(options);
}
