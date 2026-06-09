import { expect, test } from "@playwright/test";

import { WORKER_ADMIN_URL } from "../helpers/env.js";

/** Read a counter value out of the worker's Prometheus /metrics text. */
async function workerConsumed(
  request: import("@playwright/test").APIRequestContext,
): Promise<number> {
  const res = await request.get(`${WORKER_ADMIN_URL}/metrics`);
  if (!res.ok()) return 0;
  const line = (await res.text())
    .split("\n")
    .find((l) => l.startsWith("worker_tasks_consumed_total"));
  return line ? Number(line.split(/\s+/).at(-1)) : 0;
}

test.describe("tasks API", () => {
  test("create → read → list @smoke", async ({ request }) => {
    const created = await request.post("/tasks", { data: { title: "e2e task" } });
    expect(created.status()).toBe(201);
    const task = await created.json();
    expect(task.title).toBe("e2e task");
    expect(task.status).toBe("ACTIVE");
    expect(task.id).toBeTruthy();

    const read = await request.get(`/tasks/${task.id}`);
    expect(read.status()).toBe(200);
    expect((await read.json()).id).toBe(task.id);

    const list = await request.get("/tasks");
    expect(list.status()).toBe(200);
    const body = await list.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.some((t: { id: string }) => t.id === task.id)).toBe(true);
  });

  test("archive transitions the task to ARCHIVED", async ({ request }) => {
    const created = await request.post("/tasks", { data: { title: "to archive" } });
    const task = await created.json();

    // Archive uses optimistic locking — pass the task's current version.
    const archived = await request.post(`/tasks/${task.id}/archive`, {
      data: { expectedVersion: task.version },
    });
    expect([200, 201]).toContain(archived.status());

    const read = await request.get(`/tasks/${task.id}`);
    expect((await read.json()).status).toBe("ARCHIVED");
  });

  test("unknown task is a 404", async ({ request }) => {
    const res = await request.get("/tasks/does-not-exist");
    expect(res.status()).toBe(404);
  });

  test("creating a task drives the worker (Kafka → BullMQ)", async ({ request }) => {
    const before = await workerConsumed(request);

    const created = await request.post("/tasks", { data: { title: "for the worker" } });
    expect(created.status()).toBe(201);

    // The api publishes task.created best-effort; the worker consumes it.
    await expect
      .poll(async () => workerConsumed(request), { timeout: 15_000, intervals: [500] })
      .toBeGreaterThan(before);
  });
});
