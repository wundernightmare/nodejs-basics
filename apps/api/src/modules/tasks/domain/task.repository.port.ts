/**
 * Repository port for Task — the contract the application layer depends on.
 *
 * The implementation lives in `infrastructure/sql-task.repository.ts`. The
 * use case never imports the implementation directly; it injects via the
 * symbol token below so the dependency arrow points the right way (domain
 * + application know about ports; infrastructure satisfies them).
 */
import type { Task } from "./task.entity.js";

export const TASK_REPOSITORY = Symbol("TASK_REPOSITORY");

export interface CreateTaskInput {
  id: string;
  title: string;
  description: string | null;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string | null;
}

export interface TaskRepository {
  findById(id: string): Promise<Task | null>;
  list(limit: number, offset: number): Promise<Task[]>;
  create(input: CreateTaskInput): Promise<Task>;
  /**
   * Patch the task; throws `OptimisticLockConflictError` (from @base/common)
   * if `expectedVersion` does not match the row.
   */
  update(id: string, expectedVersion: number, patch: UpdateTaskInput): Promise<Task>;
  archive(id: string, expectedVersion: number): Promise<Task>;
}
