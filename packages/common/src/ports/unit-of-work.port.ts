export const UNIT_OF_WORK = Symbol("UNIT_OF_WORK");

/**
 * Generic transactional boundary. All reads + writes inside `fn` happen
 * within a single transaction; repositories pick up the active client via
 * AsyncLocalStorage (see your database package's transactionStorage).
 */
export interface IUnitOfWork {
  runInTransaction<T>(fn: () => Promise<T>): Promise<T>;
}
