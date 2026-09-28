/**
 * TaskUseCase — write-side application service.
 *
 * Demonstrates the canonical "transaction sandwich":
 *
 *   1. Cheap pre-flight work OUTSIDE the transaction (e.g. ID generation).
 *   2. Reads + writes INSIDE one transaction via IUnitOfWork.runInTransaction.
 *      Both happen on the same PoolClient, so a concurrent request cannot
 *      mutate the row between our check and our write (TOCTOU-safe).
 *   3. Events that must not be lost go into the outbox INSIDE the
 *      transaction (@base/outbox); only best-effort side effects (a cache
 *      warm-up, a metric) run after it commits.
 *
 * The use case throws domain errors (TaskNotFoundError, TaskAlreadyArchivedError,
 * OptimisticLockConflictError). The global DomainExceptionFilter maps them to
 * HTTP via apps/api/src/main.ts ERROR_MAP.
 */
import { Inject, Injectable } from "@nestjs/common";

import { generateId, type IUnitOfWork, UNIT_OF_WORK } from "@base/common";
import { TASK_EVENTS_TOPIC, type TaskCreatedEvent } from "@base/contracts";
import { AppLogger } from "@base/logger";
import { OutboxWriter } from "@base/outbox";

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
    private readonly outbox: OutboxWriter,
    appLogger: AppLogger,
  ) {
    this.logger = appLogger.child(TaskUseCase.name);
  }

  async create(cmd: CreateTaskCommand): Promise<Task> {
    // Step 1 — outside-tx work. ID generation is deterministic-enough at
    // the application layer (nanoid 21 chars → ~126 bits entropy).
    const id = generateId();

    // Step 2 — atomic write: the row and its task.created event in one
    // transaction. The event goes into the outbox (@base/outbox), not to Kafka:
    // it commits or rolls back with the task, and OutboxRelay publishes it
    // afterwards — no event lost to a broker hiccup, none for a rolled-back write.
    const task = await this.uow.runInTransaction(async () => {
      const created = await this.repo.create({
        id,
        title: cmd.title,
        description: cmd.description ?? null,
      });
      const event: TaskCreatedEvent = {
        type: "task.created",
        id: created.id,
        title: created.title,
        createdAt: created.createdAt.toISOString(),
      };
      await this.outbox.add({ topic: TASK_EVENTS_TOPIC, key: created.id, value: event });
      return created;
    });

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
