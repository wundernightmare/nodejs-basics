/**
 * Domain errors thrown by the use case. Mapped to HTTP statuses in
 * apps/api/src/main.ts ERROR_MAP via the global DomainExceptionFilter.
 *
 * Convention: every error class extends @base/common's DomainError, has a
 * `_tag` literal that matches the class name (string-narrowing for callers
 * that want to switch on the kind without instanceof), and carries no
 * HTTP semantics — only the meaning at the domain level.
 */
import { DomainError } from "@base/common";

export class TaskNotFoundError extends DomainError {
  readonly _tag = "TaskNotFoundError" as const;
  constructor(id: string) {
    super(`Task ${id} not found`);
  }
}

export class TaskAlreadyArchivedError extends DomainError {
  readonly _tag = "TaskAlreadyArchivedError" as const;
  constructor(id: string) {
    super(`Task ${id} is already archived`);
  }
}
