import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { integration, meta, testCase, unique } from "@base/testing";

import { PgUnitOfWork, TransactionAbortedError } from "./pg-unit-of-work.service.js";
import { currentTransaction, TransactionEndedError } from "./transaction.storage.js";

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
    const client = currentTransaction<Pool>();
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
      outer = currentTransaction();
      await uow.runInTransaction(async () => {
        inner = currentTransaction();
      });
    });
    expect(outer).toBeDefined();
    expect(inner).toBe(outer);
  });

  it("rejects when a statement failed and the callback swallowed the error — nothing is written", async () => {
    await testCase("NB-952", "an aborted transaction is never reported as committed");
    const before = await count();
    await expect(
      uow.runInTransaction(async () => {
        await insert("kept?");
        // "insert, catch the duplicate, carry on" — the classic shape
        await insert(null as unknown as string).catch(() => {});
      }),
    ).rejects.toBeInstanceOf(TransactionAbortedError);
    expect(await count()).toBe(before);
  });

  it("a failed nested call fails the outer transaction even when the outer one catches it", async () => {
    await testCase("NB-953", "nested failure aborts the whole transaction");
    const before = await count();
    await expect(
      uow.runInTransaction(async () => {
        await insert("outer");
        await uow.runInTransaction(() => insert(null as unknown as string)).catch(() => {});
      }),
    ).rejects.toBeInstanceOf(TransactionAbortedError);
    expect(await count()).toBe(before);
  });

  it("code that outlives its transaction cannot reach the released client", async () => {
    await testCase("NB-954", "no query on a client back in the pool");
    // A continuation registered inside the transaction, released only after
    // runInTransaction returned — no timer racing the COMMIT.
    let release!: () => void;
    const after = new Promise<void>((resolve) => {
      release = resolve;
    });
    let late: Promise<unknown> | undefined;
    await uow.runInTransaction(async () => {
      await insert("x");
      late = after.then(() => {
        try {
          return currentTransaction();
        } catch (err) {
          return err;
        }
      });
    });
    release();
    expect(await late).toBeInstanceOf(TransactionEndedError);
  });
});
