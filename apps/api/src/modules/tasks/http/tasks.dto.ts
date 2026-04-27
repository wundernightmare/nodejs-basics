/**
 * Request DTOs for tasks endpoints. Built with nestjs-zod's `createZodDto`
 * so the same schema fuels runtime validation, TS types, and (when wired)
 * Swagger.
 */
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const CreateTaskSchema = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
  })
  .strict();

export class CreateTaskDto extends createZodDto(CreateTaskSchema) {}

export const UpdateTaskSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export class UpdateTaskDto extends createZodDto(UpdateTaskSchema) {}

export const ArchiveTaskSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export class ArchiveTaskDto extends createZodDto(ArchiveTaskSchema) {}
