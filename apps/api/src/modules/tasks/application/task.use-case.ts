/**
 * TaskUseCase — write-side application service.
 *
 * Demonstrates the canonical "transaction sandwich":
 *
 *   1. Cheap pre-flight work OUTSIDE the transaction (e.g. ID generation).
 *   2. Reads + writes INSIDE one transaction via IUnitOfWork.runInTransaction.
 *      Both happen on the same PoolClient, so a concurrent request cannot
 *      mutate the row between our check and our write (TOCTOU-safe).
 *   3. Best-effort side effects (events, emails, webhooks) AFTER the
 *      transaction commits — never roll back side effects.
 *
 * The use case throws domain errors (TaskNotFoundError, TaskAlreadyArchivedError,
 * OptimisticLockConflictError). The global DomainExceptionFilter maps them to
 * HTTP via apps/api/src/main.ts ERROR_MAP.
 */
import { Inject, Injectable } from "@nestjs/common";

import { generateId, type IUnitOfWork, UNIT_OF_WORK } from "@base/common";
import { AppLogger } from "@base/logger";

import { type Task, TaskStatus } from "../domain/task.entity.js";
import { TaskAlreadyArchivedError, TaskNotFoundError } from "../domain/task.errors.js";
import {
  TASK_REPOSITORY,
  type TaskRepository,
  type UpdateTaskInput,
} from "../domain/task.repository.port.js";

export interface CreateTaskCommand {
  title: string;
  description?: string | null;
}

@Injectable()
export class TaskUseCase {
  private readonly logger: ReturnType<AppLogger["child"]>;

  constructor(
    @Inject(TASK_REPOSITORY) private readonly repo: TaskRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    appLogger: AppLogger,
  ) {
    this.logger = appLogger.child(TaskUseCase.name);
  }

  async create(cmd: CreateTaskCommand): Promise<Task> {
    // Step 1 — outside-tx work. ID generation is deterministic-enough at
    // the application layer (nanoid 21 chars → ~126 bits entropy).
    const id = generateId();

    // Step 2 — atomic write. Trivial here (single insert) but the same
    // shape scales to read-then-write flows that need TOCTOU safety.
    const task = await this.uow.runInTransaction(async () => {
      return this.repo.create({
        id,
        title: cmd.title,
        description: cmd.description ?? null,
      });
    });

    // Step 3 — side effects after commit. Example: publish a TaskCreated
    // event to Kafka here, or fire a webhook. Failure is logged, never
    // rolled back — the row is already committed.
    this.logger.info({ "task.id": task.id }, "Task created");

    return task;
  }

  async update(id: string, expectedVersion: number, patch: UpdateTaskInput): Promise<Task> {
    return this.uow.runInTransaction(async () => {
      const existing = await this.repo.findById(id);
      if (!existing) throw new TaskNotFoundError(id);

      // Repository's UPDATE clause includes `WHERE version = expectedVersion`;
      // a concurrent request bumps the version and our update returns 0 rows,
      // which the repository surfaces as OptimisticLockConflictError.
      return this.repo.update(id, expectedVersion, patch);
    });
  }

  async archive(id: string, expectedVersion: number): Promise<Task> {
    return this.uow.runInTransaction(async () => {
      const existing = await this.repo.findById(id);
      if (!existing) throw new TaskNotFoundError(id);
      if (existing.status === TaskStatus.ARCHIVED) {
        throw new TaskAlreadyArchivedError(id);
      }
      return this.repo.archive(id, expectedVersion);
    });
  }
}
