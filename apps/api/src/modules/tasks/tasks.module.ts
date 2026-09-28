/**
 * TasksModule — wires the hexagonal layers together.
 *
 * Provider patterns demonstrated:
 *   - useClass: bind a port (TASK_REPOSITORY) to its concrete implementation
 *   - useFactory: build a value from ConfigService (TASK_LIST_PAGE_SIZE)
 *
 * The schema is not the module's business: migrations/*.sql, applied by
 * apps/migrate before the app starts.
 */
import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { TaskQueryService } from "./application/task.query.service.js";
import { TaskUseCase } from "./application/task.use-case.js";
import { TASK_REPOSITORY } from "./domain/task.repository.port.js";
import { SqlTaskRepository } from "./infrastructure/sql-task.repository.js";
import { TasksController } from "./http/tasks.controller.js";
import { TASK_LIST_PAGE_SIZE } from "./tasks.tokens.js";

@Module({
  controllers: [TasksController],
  providers: [
    TaskUseCase,
    TaskQueryService,

    // Bind port → implementation. Use cases inject by TASK_REPOSITORY token.
    { provide: TASK_REPOSITORY, useClass: SqlTaskRepository },

    // Configuration-driven value provider — a typical pattern for tunables
    // that vary per environment without forcing every consumer to inject
    // ConfigService directly.
    {
      provide: TASK_LIST_PAGE_SIZE,
      inject: [ConfigService],
      useFactory: (config: ConfigService): number => {
        const raw = config.get<string>("TASK_LIST_PAGE_SIZE");
        const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
      },
    },
  ],
})
export class TasksModule {}
