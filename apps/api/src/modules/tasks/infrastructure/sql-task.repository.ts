/**
 * SqlTaskRepository — concrete pg-based implementation of TaskRepository.
 *
 * Patterns:
 *   - `db()`     — tx-aware client for reads. Picks up the ambient PoolClient
 *                  when called inside `IUnitOfWork.runInTransaction`, falls
 *                  back to the shared Pool otherwise.
 *   - `withTx()` — used for writes. Same pickup logic; opens a standalone
 *                  mini-tx if there is no ambient one.
 *
 * Optimistic locking lives here: every UPDATE includes `WHERE version = $expected`
 * and bumps `version = version + 1`. Zero rows updated → row was modified
 * concurrently → `OptimisticLockConflictError` (from @base/common).
 */
import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import { OptimisticLockConflictError } from "@base/common";
import { PG_POOL, transactionStorage } from "@base/database";

import { type Task, TaskStatus } from "../domain/task.entity.js";
import { TaskNotFoundError } from "../domain/task.errors.js";
import {
  type CreateTaskInput,
  type TaskRepository,
  type UpdateTaskInput,
} from "../domain/task.repository.port.js";

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
  version: number;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status as TaskStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

type DbClient = Pool | PoolClient;

@Injectable()
export class SqlTaskRepository implements TaskRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  // ── Read helper: tx-aware, no mini-tx ─────────────────────────────────────
  private db(): DbClient {
    return (transactionStorage.getStore() as PoolClient | undefined) ?? this.pool;
  }

  // ── Write helper: tx-aware, opens a mini-tx when standalone ───────────────
  private async withTx<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
    const ambient = transactionStorage.getStore() as PoolClient | undefined;
    if (ambient) return fn(ambient);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Swallow rollback errors — the connection may already be dead.
      }
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async findById(id: string): Promise<Task | null> {
    const result = await this.db().query<TaskRow>(
      `SELECT id, title, description, status, created_at, updated_at, version
       FROM tasks WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? rowToTask(row) : null;
  }

  async list(limit: number, offset: number): Promise<Task[]> {
    const result = await this.db().query<TaskRow>(
      `SELECT id, title, description, status, created_at, updated_at, version
       FROM tasks
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return result.rows.map(rowToTask);
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  async create(input: CreateTaskInput): Promise<Task> {
    return this.withTx(async (db) => {
      const result = await db.query<TaskRow>(
        `INSERT INTO tasks (id, title, description, status)
         VALUES ($1, $2, $3, $4)
         RETURNING id, title, description, status, created_at, updated_at, version`,
        [input.id, input.title, input.description, TaskStatus.ACTIVE],
      );
      const row = result.rows[0];
      if (!row) throw new Error("INSERT ... RETURNING produced no row");
      return rowToTask(row);
    });
  }

  async update(id: string, expectedVersion: number, patch: UpdateTaskInput): Promise<Task> {
    return this.withTx(async (db) => {
      // Build dynamic SET — only patch the fields the caller specified.
      // COALESCE-on-undefined is awkward in raw SQL, so build the clause
      // explicitly. For one or two fields this is clearest.
      const sets: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      if (patch.title !== undefined) {
        sets.push(`title = $${i++}`);
        values.push(patch.title);
      }
      if (patch.description !== undefined) {
        sets.push(`description = $${i++}`);
        values.push(patch.description);
      }
      sets.push(`updated_at = NOW()`);
      sets.push(`version = version + 1`);

      values.push(id, expectedVersion);

      const result = await db.query<TaskRow>(
        `UPDATE tasks
         SET ${sets.join(", ")}
         WHERE id = $${i++} AND version = $${i++}
         RETURNING id, title, description, status, created_at, updated_at, version`,
        values,
      );

      const row = result.rows[0];
      if (!row) {
        // Either the row vanished or its version moved. Disambiguate so the
        // 409 message is accurate; the use case has already verified existence
        // inside the same tx, so the row almost certainly exists with a newer
        // version → optimistic-lock conflict.
        const stillExists = await db.query<{ id: string }>(`SELECT id FROM tasks WHERE id = $1`, [
          id,
        ]);
        if (stillExists.rowCount === 0) throw new TaskNotFoundError(id);
        throw new OptimisticLockConflictError();
      }
      return rowToTask(row);
    });
  }

  async archive(id: string, expectedVersion: number): Promise<Task> {
    return this.withTx(async (db) => {
      const result = await db.query<TaskRow>(
        `UPDATE tasks
         SET status = $1, updated_at = NOW(), version = version + 1
         WHERE id = $2 AND version = $3
         RETURNING id, title, description, status, created_at, updated_at, version`,
        [TaskStatus.ARCHIVED, id, expectedVersion],
      );
      const row = result.rows[0];
      if (!row) {
        const stillExists = await db.query<{ id: string }>(`SELECT id FROM tasks WHERE id = $1`, [
          id,
        ]);
        if (stillExists.rowCount === 0) throw new TaskNotFoundError(id);
        throw new OptimisticLockConflictError();
      }
      return rowToTask(row);
    });
  }
}
