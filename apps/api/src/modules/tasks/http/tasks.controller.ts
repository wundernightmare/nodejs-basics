/**
 * TasksController — HTTP boundary.
 *
 * Demonstrates:
 *   - Route handlers wired to use case + query service
 *   - @Idempotent() on the create endpoint — clients send Idempotency-Key
 *   - createZodDto validation (parsed by the global ZodValidationPipe)
 *   - Throwing domain errors directly — the global DomainExceptionFilter
 *     turns them into RFC 9457 problem+json responses
 *
 * The routes, bodies and responses are what api/tsp/tasks.tsp declares; the
 * contract integration spec (app.contract.integration.spec.ts) and
 * Schemathesis hold the two together.
 */
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";

import { Idempotent } from "@base/idempotency";

import { TaskQueryService, type TaskListPage } from "../application/task.query.service.js";
import { TaskUseCase } from "../application/task.use-case.js";
import { isTaskId, type Task } from "../domain/task.entity.js";
import { TaskNotFoundError } from "../domain/task.errors.js";

import { ArchiveTaskDto, CreateTaskDto, ListTasksQueryDto, UpdateTaskDto } from "./tasks.dto.js";

/** An id outside the nanoid alphabet names no task: 404 before any query. */
function taskId(id: string): string {
  if (!isTaskId(id)) throw new TaskNotFoundError(id);
  return id;
}

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
  list(@Query() query: ListTasksQueryDto): Promise<TaskListPage> {
    return this.queries.list(query.offset ?? 0, query.limit);
  }

  @Get(":id")
  async getOne(@Param("id") id: string): Promise<Task> {
    const task = await this.queries.findById(taskId(id));
    if (!task) throw new TaskNotFoundError(id);
    return task;
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() body: UpdateTaskDto): Promise<Task> {
    const { expectedVersion, ...patch } = body;
    return this.useCase.update(taskId(id), expectedVersion, patch);
  }

  @Post(":id/archive")
  @HttpCode(200) // NestJS defaults POST to 201; archive changes a task, it creates nothing
  archive(@Param("id") id: string, @Body() body: ArchiveTaskDto): Promise<Task> {
    return this.useCase.archive(taskId(id), body.expectedVersion);
  }
}
