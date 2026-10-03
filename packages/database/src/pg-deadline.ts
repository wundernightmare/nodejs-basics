/**
 * The request budget (@base/common deadline) for Postgres.
 *
 * - Before a query: a spent budget is a DeadlineExceededError, nothing is sent
 *   (except a ROLLBACK — cleanup always goes out).
 * - Inside a unit of work: PgUnitOfWork sets `SET LOCAL statement_timeout` to
 *   what is left, so the server cancels a statement that would outlive the
 *   request — a real cancellation, and it ends with the transaction.
 * - The server's cancel (SQLSTATE 57014) under a deadline surfaces as
 *   DeadlineExceededError too (→ 504), not as a database failure (→ 500).
 * Outside a unit of work the server-wide DATABASE_STATEMENT_TIMEOUT_MS is the
 * cap; pg's client-side query_timeout is not used — it abandons the query on
 * a connection that is still executing it.
 */
import { DeadlineExceededError, remainingMs } from "@base/common";
import type { Pool, PoolClient } from "pg";

type QueryFn = (...args: unknown[]) => unknown;

const QUERY_CANCELED = "57014";
/**
 * Cleanup always goes out, budget or not: blocking a ROLLBACK after a
 * cancelled statement would hand the connection back to the pool inside an
 * aborted transaction.
 */
const ALWAYS = /^\s*ROLLBACK\b/iu;

function statementText(arg: unknown): string {
  if (typeof arg === "string") return arg;
  const text = (arg as { text?: unknown } | null)?.text;
  return typeof text === "string" ? text : "";
}

function translate(err: unknown): unknown {
  const canceled = (err as { code?: unknown } | null)?.code === QUERY_CANCELED;
  return canceled && remainingMs() !== undefined
    ? Object.assign(new DeadlineExceededError("postgres"), { cause: err })
    : err;
}

function guard(original: QueryFn): QueryFn {
  return function guardedQuery(this: unknown, ...args: unknown[]): unknown {
    const left = remainingMs();
    if (left === undefined || ALWAYS.test(statementText(args[0])))
      return original.apply(this, args);
    const cbIndex = args.findIndex((a) => typeof a === "function");
    if (left <= 0) {
      const err = new DeadlineExceededError("postgres");
      if (cbIndex === -1) return Promise.reject(err);
      (args[cbIndex] as (e: unknown) => void)(err);
      return undefined;
    }
    if (cbIndex !== -1) {
      const cb = args[cbIndex] as (e: unknown, r: unknown) => void;
      args[cbIndex] = (e: unknown, r: unknown): void => {
        cb(e === null || e === undefined ? e : translate(e), r);
      };
      return original.apply(this, args);
    }
    return (original.apply(this, args) as Promise<unknown>).catch((err: unknown) => {
      throw translate(err);
    });
  };
}

/** Applies the budget to every query of `pool` (wrap after tracePgPool: the check runs first). */
export function guardPgPool(pool: Pool): void {
  pool.on("connect", (client: PoolClient) => {
    const marked = client as PoolClient & { __baseDeadline?: true };
    if (marked.__baseDeadline) return;
    marked.__baseDeadline = true;
    const original = client.query.bind(client) as QueryFn;
    (client as unknown as { query: QueryFn }).query = guard(original);
  });
}

/** `SET LOCAL statement_timeout` for the rest of the budget; a no-op without one. */
export async function limitTransaction(client: PoolClient): Promise<void> {
  const left = remainingMs();
  if (left === undefined) return;
  if (left <= 0) throw new DeadlineExceededError("postgres");
  // An integer literal: SET does not take bind parameters.
  await client.query(`SET LOCAL statement_timeout = ${Math.ceil(left)}`);
}
