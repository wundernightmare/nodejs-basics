import { AsyncLocalStorage } from "node:async_hooks";

/** The ambient transaction: its client, and whether it is still open. */
export interface AmbientTransaction {
  /** Any ORM/driver client — a pg `PoolClient`, a Prisma `Tx`, … */
  readonly client: unknown;
  /** Cleared when the transaction ends (commit or rollback, client released). */
  open: boolean;
  /** The isolation level it runs at; undefined is the server default. */
  isolation?: string | undefined;
  /** What afterCommit registered; run once the outermost unit has committed. */
  hooks?: AfterCommitHook[];
  /** Savepoints taken so far, for unique names. */
  savepoints?: number;
}

/** Work to do once the transaction has committed (see afterCommit). */
export type AfterCommitHook = () => void | Promise<void>;

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

/**
 * Runs `hook` once the unit of work the caller is in has committed — the place
 * for what must not happen for a transaction that rolls back and cannot be
 * rolled back itself: invalidating a cache, waking a relay, publishing a
 * notification. Hooks run in registration order after the outermost commit,
 * outside the transaction (currentTransaction() is undefined again). A hook
 * registered inside a savepoint that rolled back is dropped with it.
 *
 * Outside a unit of work there is nothing to wait for and the hook runs at
 * once, so a repository can call afterCommit without knowing how it is used.
 *
 * A hook is not durable: a process that dies between the commit and the hook
 * never runs it. What must happen goes into the transaction (an outbox row).
 */
export async function afterCommit(hook: AfterCommitHook): Promise<void> {
  const tx = transactionStorage.getStore();
  if (tx === undefined) {
    await hook();
    return;
  }
  if (!tx.open) throw new TransactionEndedError();
  (tx.hooks ??= []).push(hook);
}
