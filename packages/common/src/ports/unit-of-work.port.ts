export const UNIT_OF_WORK = Symbol("UNIT_OF_WORK");

/** Transaction isolation, weakest first. The server default is "read committed". */
export type IsolationLevel = "read committed" | "repeatable read" | "serializable";

export interface UnitOfWorkOptions {
  /** Isolation level of the transaction. Default: the server's (READ COMMITTED). */
  isolation?: IsolationLevel;
  /**
   * How many times to run `fn` again when the database says a correct
   * transaction should be retried (a serialization failure or a deadlock).
   * Outermost unit only; `fn` must be safe to run more than once. Default: 0.
   */
  retries?: number;
  /**
   * Nested call only: run in a savepoint, so an error thrown by `fn` undoes
   * what `fn` wrote and the outer unit can carry on. Default: false — a
   * nested unit simply joins the outer transaction.
   */
  savepoint?: boolean;
}

/**
 * Generic transactional boundary. All reads + writes inside `fn` happen
 * within a single transaction; repositories pick up the active client via
 * AsyncLocalStorage (see your database package's transactionStorage).
 */
export interface IUnitOfWork {
  runInTransaction<T>(fn: () => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
}
