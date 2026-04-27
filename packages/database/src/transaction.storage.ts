import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Stores the active DB transaction client when inside a UnitOfWork.
 * Repositories read from this storage to participate in the ambient transaction.
 *
 * The stored value is intentionally `unknown` so any ORM/driver client type
 * works — e.g. a Prisma `Tx` or a pg `PoolClient`. Cast at the read site
 * inside your repository:
 *
 *   const tx = transactionStorage.getStore() as MyTxClient | undefined;
 */
export const transactionStorage = new AsyncLocalStorage<unknown>();
