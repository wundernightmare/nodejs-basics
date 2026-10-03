import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import { type IUnitOfWork } from "@base/common";

import { limitTransaction } from "./pg-deadline.js";
import { PG_POOL } from "./pg-pool.provider.js";
import { currentTransaction, transactionStorage } from "./transaction.storage.js";

/**
 * Pg-based UnitOfWork.
 *
 *   const uow: IUnitOfWork;        // injected via UNIT_OF_WORK token
 *   await uow.runInTransaction(async () => {
 *     // every repository read/write inside this fn participates in the same tx —
 *     // they pick up the active PoolClient via currentTransaction()
 *   });
 *
 * A nested call joins the outer transaction (no savepoint): an error inside it
 * is the outer transaction's error. Catching it and carrying on does not undo
 * what the inner call wrote — and if a statement failed, Postgres has aborted
 * the whole transaction: COMMIT then rolls back, and runInTransaction rejects
 * with TransactionAbortedError instead of reporting a write that never happened.
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
    // Nested call: join the ambient transaction (see the class comment).
    if (currentTransaction() !== undefined) return fn();

    const client = await this.pool.connect();
    const tx = { client, open: true };
    // Set when ROLLBACK fails: the connection is in an unknown state and is
    // destroyed on release instead of going back to the pool.
    let broken: Error | undefined;
    try {
      await client.query("BEGIN");
      // Under a request deadline the server cancels a statement that would
      // outlive it (SET LOCAL: this transaction only).
      await limitTransaction(client);
      const result = await transactionStorage.run(tx, fn);
      await commit(client);
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        broken = rollbackErr as Error;
      }
      throw err;
    } finally {
      // Continuations scheduled inside fn must not reach this client any more.
      tx.open = false;
      client.release(broken);
    }
  }
}

/** fn completed, but a statement inside it failed: Postgres rolled the transaction back. */
export class TransactionAbortedError extends Error {
  constructor() {
    super(
      "Transaction rolled back: a statement inside it failed (the error was caught and the " +
        "work carried on). Nothing it wrote was committed.",
    );
    this.name = "TransactionAbortedError";
  }
}

/**
 * COMMIT that fails loudly. In a transaction a failed statement aborted,
 * Postgres answers COMMIT with ROLLBACK — no error — so a caller that caught
 * the statement's error would see "success" for writes that were all undone.
 */
export async function commit(client: PoolClient): Promise<void> {
  const result = await client.query("COMMIT");
  if (result.command !== "COMMIT") throw new TransactionAbortedError();
}
