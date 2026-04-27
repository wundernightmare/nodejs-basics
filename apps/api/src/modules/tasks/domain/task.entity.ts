/**
 * Task — domain entity.
 *
 * Pure data structure. No NestJS, no Prisma, no HTTP. The only outside
 * concept it leans on is the optimistic-lock `version` field, which the
 * repository increments on every write (see TaskAlreadyArchivedError +
 * OptimisticLockConflictError mapping in main.ts ERROR_MAP).
 */

export const TaskStatus = {
  ACTIVE: "ACTIVE",
  ARCHIVED: "ARCHIVED",
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  createdAt: Date;
  updatedAt: Date;
  /** Optimistic-lock counter — incremented on every UPDATE, used in WHERE. */
  version: number;
}
