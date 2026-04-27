/**
 * Creates the `tasks` table on module init if it does not already exist.
 *
 * THIS IS A SHORTCUT FOR THE TEMPLATE. In a real project, manage schema
 * with a proper migration tool (node-pg-migrate, Prisma migrate, drizzle-kit,
 * sqitch, atlas — pick one and stick with it) and DELETE this file.
 *
 * The DDL kept here mirrors what the example migration would be:
 *   - id          nanoid 21-char string (generated at the application layer)
 *   - status      const-enum-style text + CHECK
 *   - version     integer optimistic-lock counter, starts at 0
 *   - created_at / updated_at — set by NOW()
 */
import { Inject, Injectable, OnApplicationBootstrap } from "@nestjs/common";
import type { Pool } from "pg";

import { PG_POOL } from "@base/database";
import { AppLogger } from "@base/logger";

const TASKS_DDL = `
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS tasks_status_created_at_idx
  ON tasks (status, created_at DESC);
`;

@Injectable()
export class TasksSchemaBootstrap implements OnApplicationBootstrap {
  private readonly logger: ReturnType<AppLogger["child"]>;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    appLogger: AppLogger,
  ) {
    this.logger = appLogger.child(TasksSchemaBootstrap.name);
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.pool.query(TASKS_DDL);
    this.logger.info("tasks table ready");
  }
}
