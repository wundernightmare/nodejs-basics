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

/**
 * Shape of a task id: a 21-character nanoid over the URL-safe alphabet
 * (@base/common `generateId`). The HTTP boundary uses it to answer 404 for an
 * id that cannot exist without a round-trip — and without handing PostgreSQL
 * a NUL byte, which its TEXT type rejects with an error.
 */
export const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{21}$/u;

export function isTaskId(id: string): boolean {
  return TASK_ID_PATTERN.test(id);
}

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
