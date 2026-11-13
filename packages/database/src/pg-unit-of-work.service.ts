import { setTimeout as delay } from "node:timers/promises";

import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import { type IsolationLevel, type IUnitOfWork, type UnitOfWorkOptions } from "@base/common";

import { limitTransaction } from "./pg-deadline.js";
import { PG_POOL } from "./pg-pool.provider.js";
import {
  type AfterCommitHook,
  type AmbientTransaction,
  TransactionEndedError,
  transactionStorage,
} from "./transaction.storage.js";

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
 * With `{ savepoint: true }` the nested call runs in a savepoint instead: its
 * error undoes its own writes and the outer unit can carry on.
 *
 * Options (the same set as golang-basics' pgx.InTx):
 *   - `isolation`: the level of the transaction. A nested call that asks for a
 *     stricter level than the outer one runs at fails with TxOptionsError —
 *     the alternative is a use case that believes it is SERIALIZABLE and is not.
 *   - `retries`: run `fn` again after a serialization failure (40001) or a
 *     deadlock (40P01), with a short random pause. Outermost unit only (a
 *     nested one cannot be run again on its own: TxOptionsError).
 *
 * afterCommit(hook) (./transaction.storage) runs work once the outermost unit
 * has committed. The commit stands whatever a hook does: every hook runs, and
 * if one threw, runInTransaction rejects with AfterCommitError.
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

  async runInTransaction<T>(fn: () => Promise<T>, options: UnitOfWorkOptions = {}): Promise<T> {
    const outer = transactionStorage.getStore();
    if (outer !== undefined) return this.#nested(outer, fn, options);

    const retries = options.retries ?? 0;
    for (let attempt = 0; ; attempt++) {
      let hooks: AfterCommitHook[];
      let result: T;
      try {
        ({ result, hooks } = await this.#once(fn, options.isolation));
      } catch (err) {
        if (attempt >= retries || !isRetryable(err)) throw err;
        await pause(attempt + 1);
        continue;
      }
      await runHooks(hooks);
      return result;
    }
  }

  /** One attempt: BEGIN, fn, COMMIT — or ROLLBACK. Returns what afterCommit registered. */
  async #once<T>(
    fn: () => Promise<T>,
    isolation: IsolationLevel | undefined,
  ): Promise<{ result: T; hooks: AfterCommitHook[] }> {
    const client = await this.pool.connect();
    const tx: AmbientTransaction = { client, open: true, isolation, hooks: [] };
    // Set when ROLLBACK fails: the connection is in an unknown state and is
    // destroyed on release instead of going back to the pool.
    let broken = false;
    try {
      await client.query(
        isolation === undefined ? "BEGIN" : `BEGIN ISOLATION LEVEL ${ISOLATION_SQL[isolation]}`,
      );
      // Under a request deadline the server cancels a statement that would
      // outlive it (SET LOCAL: this transaction only).
      await limitTransaction(client);
      const result = await transactionStorage.run(tx, fn);
      await commit(client);
      return { result, hooks: tx.hooks ?? [] };
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        broken = true;
      }
      throw err;
    } finally {
      // Continuations scheduled inside fn must not reach this client any more.
      tx.open = false;
      client.release(broken);
    }
  }

  /** A call inside a unit: join it, or — `savepoint` — run in a savepoint of it. */
  async #nested<T>(
    outer: AmbientTransaction,
    fn: () => Promise<T>,
    options: UnitOfWorkOptions,
  ): Promise<T> {
    if (!outer.open) throw new TransactionEndedError();
    if ((options.retries ?? 0) > 0 || rank(options.isolation) > rank(outer.isolation)) {
      throw new TxOptionsError();
    }
    if (options.savepoint !== true) return fn();

    const client = outer.client as PoolClient;
    outer.savepoints = (outer.savepoints ?? 0) + 1;
    const name = `uow_${outer.savepoints}`;
    const kept = outer.hooks ?? [];
    // Hooks registered inside are kept only if the savepoint is.
    outer.hooks = [];
    await client.query(`SAVEPOINT ${name}`);
    try {
      const result = await fn();
      await client.query(`RELEASE SAVEPOINT ${name}`);
      outer.hooks = [...kept, ...outer.hooks];
      return result;
    } catch (err) {
      outer.hooks = kept;
      // Throws when the transaction itself is gone (connection lost): the
      // outer unit then fails on its next statement, with that error.
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => {});
      throw err;
    }
  }
}

const ISOLATION_SQL: Record<IsolationLevel, string> = {
  "read committed": "READ COMMITTED",
  "repeatable read": "REPEATABLE READ",
  serializable: "SERIALIZABLE",
};

const ISOLATION_RANK: Record<string, number> = {
  "read committed": 0,
  "repeatable read": 1,
  serializable: 2,
};

/** How strict a level is; the server default counts as READ COMMITTED. */
function rank(level: string | undefined): number {
  return level === undefined ? 0 : (ISOLATION_RANK[level] ?? 0);
}

/** SQLSTATE codes after which the same transaction may succeed when run again. */
const RETRYABLE_CODES: ReadonlySet<unknown> = new Set(["40001", "40P01"]);

function isRetryable(err: unknown): boolean {
  return RETRYABLE_CODES.has((err as { code?: unknown } | null)?.code);
}

/** Upper bound of the random pause before the first retry; grows linearly with the attempt. */
const RETRY_PAUSE_MS = 10;

function pause(attempt: number): Promise<void> {
  return delay(Math.random() * RETRY_PAUSE_MS * attempt);
}

/** Runs every hook, in order; the first error is reported once all have run. */
async function runHooks(hooks: AfterCommitHook[]): Promise<void> {
  const errors: unknown[] = [];
  for (const hook of hooks) {
    try {
      await hook();
    } catch (err) {
      errors.push(err);
    }
  }
  if (errors.length > 0) throw new AfterCommitError(errors);
}

/** A nested unit of work asked for more than the transaction it would join gives. */
export class TxOptionsError extends Error {
  constructor() {
    super(
      "A nested unit of work asked for more than the outer transaction gives: a stricter " +
        "isolation level, or retries (only the outermost unit can be run again).",
    );
    this.name = "TxOptionsError";
  }
}

/** The transaction committed; one or more afterCommit hooks then failed. */
export class AfterCommitError extends Error {
  constructor(public readonly errors: unknown[]) {
    super(
      `The transaction committed, but ${errors.length} afterCommit hook(s) failed. ` +
        "Nothing was rolled back.",
      { cause: errors[0] },
    );
    this.name = "AfterCommitError";
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
