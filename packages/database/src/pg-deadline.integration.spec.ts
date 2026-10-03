import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DeadlineExceededError, withDeadline } from "@base/common";
import { integration, meta, testCase } from "@base/testing";

import { guardPgPool } from "./pg-deadline.js";
import { PgUnitOfWork } from "./pg-unit-of-work.service.js";
import { currentTransaction } from "./transaction.storage.js";

/** The server really cancels a statement that would outlive the request. */
const infra = integration("postgres");

describe.skipIf(infra.skip)("pg deadline (integration)", () => {
  meta({
    epic: "nodejs-basics",
    feature: "deadlines",
    owner: "@team-platform",
    tags: ["database", "deadline", "integration"],
  });

  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: infra.url("postgres"), max: 2 });
    guardPgPool(pool);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("cancels a transaction's statement at the deadline and answers DeadlineExceededError", async () => {
    await testCase("NB-614", "pg_sleep(5) under a 300 ms budget → cancelled server-side");
    const uow = new PgUnitOfWork(pool);
    const started = Date.now();
    await expect(
      withDeadline(300, () =>
        uow.runInTransaction(async () => {
          const client = currentTransaction<Pool>()!;
          await client.query("SELECT pg_sleep(5)");
        }),
      ),
    ).rejects.toThrow(DeadlineExceededError);
    expect(Date.now() - started).toBeLessThan(2_000);
    // The connection went back to the pool usable.
    expect((await pool.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
  });
});
