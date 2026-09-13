/**
 * Request DTOs for tasks endpoints. Built with nestjs-zod's `createZodDto`
 * so the same schema fuels runtime validation and TS types.
 *
 * They mirror the contract (api/tsp/tasks.tsp) member for member: the
 * document promises what is accepted, these schemas enforce it, and
 * Schemathesis (`just schemathesis`) checks the two agree — a
 * schema-compliant request is always accepted, a non-compliant one is a 400
 * problem, never a 500.
 */
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

/** Length in code points — what JSON Schema's minLength/maxLength count. */
function codePoints(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    n++;
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) i++; // surrogate pair = one code point
  }
  return n;
}

/**
 * Free text of `min`..`max` characters. PostgreSQL TEXT rejects a NUL byte —
 * the one string the store cannot hold — so it is refused here as a 400.
 * Lengths count code points (zod's .min/.max count UTF-16 units, which would
 * reject a 200-character title of astral characters the contract allows).
 */
function text(min: number, max: number) {
  return z
    .string()
    .refine((s) => !s.includes("\u0000"), { message: "must not contain a NUL character" })
    .refine(
      (s) => {
        const n = codePoints(s);
        return n >= min && n <= max;
      },
      { message: `must be ${min} to ${max} characters` },
    );
}

/** A non-negative integer query parameter — the exact decimal form, nothing coerced. */
function intQuery(min: number, max: number) {
  return z
    .string()
    .regex(/^\d+$/u, "must be an integer")
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));
}

export const CreateTaskSchema = z
  .object({
    title: text(1, 200),
    description: text(0, 2000).optional(),
  })
  .strict();

export class CreateTaskDto extends createZodDto(CreateTaskSchema) {}

export const UpdateTaskSchema = z
  .object({
    title: text(1, 200).optional(),
    description: text(0, 2000).nullable().optional(),
    expectedVersion: z.number().int().nonnegative().max(2_147_483_647),
  })
  .strict();

export class UpdateTaskDto extends createZodDto(UpdateTaskSchema) {}

export const ArchiveTaskSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative().max(2_147_483_647),
  })
  .strict();

export class ArchiveTaskDto extends createZodDto(ArchiveTaskSchema) {}

/**
 * GET /tasks?offset&limit — `limit` absent means the server default
 * (TASK_LIST_PAGE_SIZE). Closed like the bodies: an unknown query parameter is
 * a 400 problem (a typo in `limti` must not silently return the default page).
 */
export const ListTasksQuerySchema = z
  .object({
    offset: intQuery(0, 2_147_483_647).optional(),
    limit: intQuery(1, 1000).optional(),
  })
  .strict();

export class ListTasksQueryDto extends createZodDto(ListTasksQuerySchema) {}
