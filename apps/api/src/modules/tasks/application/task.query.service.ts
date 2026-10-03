/**
 * TaskQueryService — read-side application service.
 *
 * Reads bypass the domain entity / use-case / repository-port stack and go
 * directly through the pool. This avoids the cost of hydrating domain
 * entities for queries that just shape rows for the HTTP boundary, and
 * removes the temptation to add use-case logic on the read path.
 *
 * For multi-row reads always paginate (limit + offset), and prefer one
 * query with JOIN/include over N+1 fan-out.
 */
import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";

import { PG_POOL } from "@base/database";

import type { Task, TaskStatus } from "../domain/task.entity.js";
import { TASK_LIST_PAGE_SIZE } from "../tasks.tokens.js";

export interface TaskListItem {
  id: string;
  title: string;
  status: string;
  createdAt: Date;
}

export interface TaskListPage {
  items: TaskListItem[];
  total: number;
}

@Injectable()
export class TaskQueryService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(TASK_LIST_PAGE_SIZE) private readonly defaultPageSize: number,
  ) {}

  /** One task by id — the read side of GET /tasks/{id}; null when unknown. */
  async findById(id: string): Promise<Task | null> {
    const result = await this.pool.query<{
      id: string;
      title: string;
      description: string | null;
      status: string;
      created_at: Date;
      updated_at: Date;
      version: number;
    }>(
      `SELECT id, title, description, status, created_at, updated_at, version
       FROM tasks WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
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

  async list(offset = 0, limit?: number): Promise<TaskListPage> {
    const pageSize = limit ?? this.defaultPageSize;
    const [rows, count] = await Promise.all([
      this.pool.query<{ id: string; title: string; status: string; created_at: Date }>(
        `SELECT id, title, status, created_at
         FROM tasks
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        [pageSize, offset],
      ),
      this.pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM tasks`),
    ]);

    return {
      items: rows.rows.map((r) => ({
        id: r.id,
        title: r.title,
        status: r.status,
        createdAt: r.created_at,
      })),
      total: Number(count.rows[0]?.count ?? "0"),
    };
  }
}
