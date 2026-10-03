import { expect, test } from "@playwright/test";

import { createTasksClient } from "@base/contracts";

import { E2E, meta, testCase } from "../fixtures/meta.js";
import { API_URL, WORKER_ADMIN_URL } from "../helpers/env.js";

/**
 * The api through the typed client generated from the contract — what another
 * service would use: a path, a parameter or a body the contract does not
 * have does not compile, and each response is typed by its status.
 */
const api = createTasksClient({ baseUrl: API_URL });

const FEATURE = { ...E2E, feature: "tasks API" };

/** Read a counter value out of the worker's Prometheus /metrics text. */
async function workerConsumed(
  request: import("@playwright/test").APIRequestContext,
): Promise<number> {
  const res = await request.get(`${WORKER_ADMIN_URL}/metrics`);
  if (!res.ok()) return 0;
  const line = (await res.text())
    .split("\n")
    .find((l) => l.startsWith("worker_tasks_consumed_total"));
  return line ? Number(line.split(/\s+/u).at(-1)) : 0;
}

test.describe("tasks API", () => {
  test("create → read → list @smoke", async () => {
    await meta(FEATURE);
    await testCase("NB-511", "the tasks vertical works end to end over HTTP");
    const created = await api.POST("/tasks", { body: { title: "e2e task" } });
    expect(created.response.status).toBe(201);
    const task = created.data!;
    expect(task.title).toBe("e2e task");
    expect(task.status).toBe("ACTIVE");
    expect(task.id).toBeTruthy();

    const read = await api.GET("/tasks/{id}", { params: { path: { id: task.id } } });
    expect(read.response.status).toBe(200);
    expect(read.data?.id).toBe(task.id);

    const list = await api.GET("/tasks", { params: { query: { limit: 100 } } });
    expect(list.response.status).toBe(200);
    expect(list.data?.items.some((t) => t.id === task.id)).toBe(true);
  });

  test("archive transitions the task to ARCHIVED", async () => {
    await meta(FEATURE);
    await testCase("NB-512", "archive with optimistic locking");
    const task = (await api.POST("/tasks", { body: { title: "to archive" } })).data!;

    // Archive uses optimistic locking — pass the task's current version.
    const archived = await api.POST("/tasks/{id}/archive", {
      params: { path: { id: task.id } },
      body: { expectedVersion: task.version },
    });
    expect(archived.response.status).toBe(200);
    expect(archived.data?.status).toBe("ARCHIVED");

    // A stale version is the contract's 409 problem.
    const stale = await api.POST("/tasks/{id}/archive", {
      params: { path: { id: task.id } },
      body: { expectedVersion: task.version },
    });
    expect(stale.response.status).toBe(409);
    expect(stale.error?.status).toBe(409);
  });

  test("unknown task is a 404 problem+json", async () => {
    await meta(FEATURE);
    await testCase("NB-513", "a missing task is an RFC 9457 problem");
    const res = await api.GET("/tasks/{id}", { params: { path: { id: "does-not-exist" } } });
    expect(res.response.status).toBe(404);
    expect(res.response.headers.get("content-type")).toContain("application/problem+json");
    expect(res.error?.status).toBe(404);
    expect(res.error?.title).toBeTruthy();
  });

  test("creating a task drives the worker (Kafka → BullMQ)", async ({ request }) => {
    await meta(FEATURE);
    await testCase("NB-514", "cross-process flow api → Kafka → worker");
    const before = await workerConsumed(request);

    const created = await api.POST("/tasks", { body: { title: "for the worker" } });
    expect(created.response.status).toBe(201);

    // task.created goes api → outbox → relay → Kafka → worker.
    await expect
      .poll(async () => workerConsumed(request), { timeout: 15_000, intervals: [500] })
      .toBeGreaterThan(before);
  });
});
