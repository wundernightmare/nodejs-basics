import { AsyncLocalStorage } from "node:async_hooks";

/** The ambient transaction: its client, and whether it is still open. */
export interface AmbientTransaction {
  /** Any ORM/driver client — a pg `PoolClient`, a Prisma `Tx`, … */
  readonly client: unknown;
  /** Cleared when the transaction ends (commit or rollback, client released). */
  open: boolean;
}

/**
 * The active DB transaction when inside a UnitOfWork. Read it through
 * `currentTransaction()`, not `getStore()`: the store travels with every
 * continuation scheduled inside the transaction — a timer, an un-awaited
 * promise — including ones that run after it ended.
 */
export const transactionStorage = new AsyncLocalStorage<AmbientTransaction>();

/** Code that outlived its transaction asked for it. */
export class TransactionEndedError extends Error {
  constructor() {
    super(
      "The transaction this code was started in has ended — its client is back in the pool " +
        "and may belong to another request. Await the work inside runInTransaction, or start " +
        "a new one.",
    );
    this.name = "TransactionEndedError";
  }
}

/**
 * The client of the transaction the caller runs in, or undefined outside one.
 * Throws TransactionEndedError for a continuation scheduled inside a
 * transaction that has since committed or rolled back.
 *
 *   const db = currentTransaction<PoolClient>() ?? this.pool;
 */
// oxlint-disable-next-line no-unnecessary-type-parameters -- a typed accessor: the store holds any ORM client
export function currentTransaction<T>(): T | undefined {
  const tx = transactionStorage.getStore();
  if (tx === undefined) return undefined;
  if (!tx.open) throw new TransactionEndedError();
  return tx.client as T;
}
