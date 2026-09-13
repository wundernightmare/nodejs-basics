import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OptimisticLockConflictError } from "@base/common";
import type { AppLogger } from "@base/logger";
import { integration, meta, testCase, unique } from "@base/testing";

import { TaskStatus } from "../domain/task.entity.js";
import { TaskNotFoundError } from "../domain/task.errors.js";
import { SqlTaskRepository } from "./sql-task.repository.js";
import { TasksSchemaBootstrap } from "./tasks-schema.bootstrap.js";

/**
 * The tasks repository against a real Postgres (DATABASE_URL from `just deps`
 * or the CI service), wired the way the module wires it: the schema bootstrap
 * creates the table, the repository runs its own mini-transactions. Rows are
 * isolated by unique ids in the shared `tasks` table — the same table the
 * running api uses, so nothing here assumes an empty database.
 */
const infra = integration("postgres");

describe.skipIf(infra.skip)("SqlTaskRepository (integration)", () => {
  meta({
    epic: "nodejs-basics",
    feature: "tasks API",
    owner: "@team-platform",
    tags: ["api", "tasks", "integration"],
  });

  let pool: Pool;
  let repo: SqlTaskRepository;
  const created: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: infra.url("postgres"), max: 3 });
    const silent = { child: () => ({ info: () => undefined }) } as unknown as AppLogger;
    await new TasksSchemaBootstrap(pool, silent).onApplicationBootstrap();
    repo = new SqlTaskRepository(pool);
  });

  afterAll(async () => {
    if (created.length > 0) await pool.query("DELETE FROM tasks WHERE id = ANY($1)", [created]);
    await pool.end();
  });

  async function create(title: string): Promise<ReturnType<SqlTaskRepository["create"]>> {
    const id = unique("task");
    created.push(id);
    return repo.create({ id, title, description: null });
  }

  it("creates an ACTIVE task at version 0 and reads it back", async () => {
    await testCase("NB-101", "create + findById round-trip");
    const task = await create("first");
    expect(task).toMatchObject({ title: "first", status: TaskStatus.ACTIVE, version: 0 });
    expect(await repo.findById(task.id)).toEqual(task);
    expect(await repo.findById("does-not-exist")).toBeNull();
  });

  it("lists newest first within the page", async () => {
    await testCase("NB-102", "list is ordered by created_at desc");
    const a = await create("older");
    const b = await create("newer");
    const ids = (await repo.list(50, 0)).map((t) => t.id);
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
  });

  it("update bumps the version and rejects a stale one", async () => {
    await testCase("NB-103", "optimistic locking on update");
    const task = await create("to update");
    const updated = await repo.update(task.id, 0, { title: "updated" });
    expect(updated).toMatchObject({ title: "updated", version: 1 });
    await expect(repo.update(task.id, 0, { title: "stale" })).rejects.toBeInstanceOf(
      OptimisticLockConflictError,
    );
    await expect(repo.update("does-not-exist", 0, { title: "x" })).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
  });

  it("archive transitions to ARCHIVED under the same lock", async () => {
    await testCase("NB-104", "optimistic locking on archive");
    const task = await create("to archive");
    const archived = await repo.archive(task.id, task.version);
    expect(archived).toMatchObject({ status: TaskStatus.ARCHIVED, version: 1 });
    await expect(repo.archive(task.id, 0)).rejects.toBeInstanceOf(OptimisticLockConflictError);
  });
});
