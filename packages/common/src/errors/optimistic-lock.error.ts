import { DomainError } from "./domain-error.base.js";

export class OptimisticLockConflictError extends DomainError {
  readonly _tag = "OptimisticLockConflictError" as const;
  constructor() {
    super("The record was modified by another request. Reload and retry.");
  }
}
