import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { integration, meta, testCase, unique } from "@base/testing";

import { PgUnitOfWork } from "./pg-unit-of-work.service.js";
import { transactionStorage } from "./transaction.storage.js";

/**
 * The unit of work against a real Postgres (DATABASE_URL from `just deps` or
 * the CI service): a transaction commits as one, rolls back as one, and the
 * ambient client is visible to everything that runs inside it. The pool is
 * the plain pg.Pool the provider builds; isolation is a unique table, never
 * a fresh database.
 */
const infra = integration("postgres");

describe.skipIf(infra.skip)("PgUnitOfWork (integration)", () => {
  meta({
    epic: "nodejs-basics",
    feature: "database",
    owner: "@team-platform",
    tags: ["database", "integration"],
  });

  const table = unique("uow");
  let pool: Pool;
  let uow: PgUnitOfWork;

  beforeAll(async () => {
    pool = new Pool({ connectionString: infra.url("postgres"), max: 3 });
    await pool.query(`CREATE TABLE ${table} (id serial PRIMARY KEY, v text NOT NULL)`);
    uow = new PgUnitOfWork(pool);
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${table}`);
    await pool.end();
  });

  /** Insert through the ambient transaction client when there is one, else the pool. */
  async function insert(v: string): Promise<void> {
    const client = transactionStorage.getStore() as Pool | undefined;
    await (client ?? pool).query(`INSERT INTO ${table} (v) VALUES ($1)`, [v]);
  }

  async function count(): Promise<number> {
    const res = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
    return Number(res.rows[0]?.n ?? 0);
  }

  it("commits every write of the callback as one transaction", async () => {
    await testCase("NB-201", "unit of work commits atomically");
    const before = await count();
    await uow.runInTransaction(async () => {
      await insert("a");
      await insert("b");
    });
    expect(await count()).toBe(before + 2);
  });

  it("rolls every write back when the callback throws", async () => {
    await testCase("NB-202", "unit of work rolls back atomically");
    const before = await count();
    await expect(
      uow.runInTransaction(async () => {
        await insert("c");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await count()).toBe(before);
  });

  it("joins an ambient transaction instead of opening a nested one", async () => {
    await testCase("NB-203", "nested runInTransaction reuses the outer client");
    let inner: unknown;
    let outer: unknown;
    await uow.runInTransaction(async () => {
      outer = transactionStorage.getStore();
      await uow.runInTransaction(async () => {
        inner = transactionStorage.getStore();
      });
    });
    expect(outer).toBeDefined();
    expect(inner).toBe(outer);
  });
});
