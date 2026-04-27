import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import { type IUnitOfWork } from "@base/common";

import { PG_POOL } from "./pg-pool.provider.js";
import { transactionStorage } from "./transaction.storage.js";

/**
 * Pg-based UnitOfWork.
 *
 *   const uow: IUnitOfWork;        // injected via UNIT_OF_WORK token
 *   await uow.runInTransaction(async () => {
 *     // every repository read/write inside this fn participates in the same tx —
 *     // they pick up the active PoolClient via transactionStorage.getStore()
 *   });
 *
 * Wire in AppModule (alongside DatabaseModule):
 *   { provide: UNIT_OF_WORK, useClass: PgUnitOfWork }
 *
 * Repositories should expose a `withTx` helper for writes and a `db()` helper
 * for reads — see the `tasks` example module for the canonical shape.
 */
@Injectable()
export class PgUnitOfWork implements IUnitOfWork {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    // Reuse the ambient client when callers nest UoW invocations — postgres
    // would happily nest savepoints, but most app code expects a flat tx and
    // a nested BEGIN inside an existing tx is a no-op anyway.
    const ambient = transactionStorage.getStore() as PoolClient | undefined;
    if (ambient) return fn();

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await transactionStorage.run(client, fn);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The connection may already be dead — pg will recycle it on release.
      }
      throw err;
    } finally {
      client.release();
    }
  }
}
