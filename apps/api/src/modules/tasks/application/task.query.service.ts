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
      total: parseInt(count.rows[0]?.count ?? "0", 10),
    };
  }
}
