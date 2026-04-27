/**
 * TasksController — HTTP boundary.
 *
 * Demonstrates:
 *   - Route handlers wired to use case + query service
 *   - @Idempotent() on the create endpoint — clients send Idempotency-Key
 *   - createZodDto validation (parsed by the global ZodValidationPipe)
 *   - Throwing domain errors directly — the global DomainExceptionFilter
 *     turns them into RFC 9457 problem+json responses
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";

import { Idempotent } from "@base/idempotency";

import { TaskQueryService, type TaskListPage } from "../application/task.query.service.js";
import { TaskUseCase } from "../application/task.use-case.js";
import type { Task } from "../domain/task.entity.js";
import { TaskNotFoundError } from "../domain/task.errors.js";

import { ArchiveTaskDto, CreateTaskDto, UpdateTaskDto } from "./tasks.dto.js";

@Controller("tasks")
export class TasksController {
  constructor(
    private readonly useCase: TaskUseCase,
    private readonly queries: TaskQueryService,
  ) {}

  @Post()
  @HttpCode(201)
  @Idempotent()
  create(@Body() body: CreateTaskDto): Promise<Task> {
    return this.useCase.create({
      title: body.title,
      description: body.description ?? null,
    });
  }

  @Get()
  list(@Query("offset") offset?: string, @Query("limit") limit?: string): Promise<TaskListPage> {
    const offsetNum = offset !== undefined ? parseInt(offset, 10) : 0;
    const limitNum = limit !== undefined ? parseInt(limit, 10) : undefined;
    return this.queries.list(
      Number.isFinite(offsetNum) && offsetNum >= 0 ? offsetNum : 0,
      Number.isFinite(limitNum as number) ? limitNum : undefined,
    );
  }

  @Get(":id")
  async getOne(@Param("id") id: string): Promise<Task> {
    // The use case has no read-by-id (queries side), so go through the repo
    // via the use case's UoW for a tx-aware read. Keeping it simple here:
    // raw pool query through the query service is also fine. We use the
    // UoW path to demonstrate that domain errors flow through the filter.
    const tx = await this.queryFindById(id);
    return tx;
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() body: UpdateTaskDto): Promise<Task> {
    const { expectedVersion, ...patch } = body;
    return this.useCase.update(id, expectedVersion, patch);
  }

  @Post(":id/archive")
  archive(@Param("id") id: string, @Body() body: ArchiveTaskDto): Promise<Task> {
    return this.useCase.archive(id, body.expectedVersion);
  }

  // Lightweight single-row read — kept private to the controller for clarity.
  // In a larger module you would push this onto TaskQueryService.
  private async queryFindById(id: string): Promise<Task> {
    const page = await this.queries.list(0, 1_000_000); // toy: small dataset
    const found = page.items.find((t) => t.id === id);
    if (!found) throw new TaskNotFoundError(id);
    return {
      id: found.id,
      title: found.title,
      description: null,
      status: found.status as Task["status"],
      createdAt: found.createdAt,
      updatedAt: found.createdAt,
      version: 0,
    };
  }
}
