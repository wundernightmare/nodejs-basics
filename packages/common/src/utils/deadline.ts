import { AsyncLocalStorage } from "node:async_hooks";

import { DomainError } from "../errors/domain-error.base.js";

/**
 * The request budget: one deadline per unit of work (an HTTP request, a
 * job), carried in AsyncLocalStorage and honoured by every outbound call made
 * under it — Postgres, Valkey, HTTP. A dependency then gets "what is left of
 * the caller's budget", capped by its own timeout, instead of a fixed timeout
 * that can outlive the request it serves.
 *
 * Across services the remaining budget travels as `x-request-timeout-ms`
 * (relative milliseconds — immune to clock skew, like gRPC's grpc-timeout):
 * resilient-client sends it, registerRequestContext reads it, capped by the
 * server's own HTTP_REQUEST_TIMEOUT_MS.
 */
const deadlineStorage = new AsyncLocalStorage<number>();

/** Header carrying the caller's remaining budget in milliseconds. */
export const REQUEST_TIMEOUT_HEADER = "x-request-timeout-ms";

/** The budget ran out before (or while) a dependency was called → 504. */
export class DeadlineExceededError extends DomainError {
  readonly _tag = "DeadlineExceededError";

  constructor(what = "request") {
    super(`deadline exceeded (${what})`);
  }
}

/**
 * Runs fn with a deadline `timeoutMs` from now — or the enclosing one, when
 * that is sooner: a nested budget never extends its caller's.
 */
export function withDeadline<T>(timeoutMs: number, fn: () => T): T {
  const at = Date.now() + timeoutMs;
  const outer = deadlineStorage.getStore();
  return deadlineStorage.run(outer === undefined ? at : Math.min(outer, at), fn);
}

/** Milliseconds left of the current budget (≤ 0 when spent); undefined outside one. */
export function remainingMs(): number | undefined {
  const at = deadlineStorage.getStore();
  return at === undefined ? undefined : at - Date.now();
}

/**
 * The time an outbound call may take: its own timeout, or what is left of
 * the budget when that is less. Throws DeadlineExceededError when nothing is
 * left — the call is not worth starting.
 */
export function callBudgetMs(ownTimeoutMs: number, what?: string): number {
  const left = remainingMs();
  if (left === undefined) return ownTimeoutMs;
  if (left <= 0) throw new DeadlineExceededError(what);
  return Math.min(ownTimeoutMs, Math.ceil(left));
}

/** A positive integer number of milliseconds from a header value, else undefined. */
export function parseTimeoutMs(value: unknown): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || !/^\d{1,9}$/u.test(raw)) return undefined;
  const ms = Number(raw);
  return ms > 0 ? ms : undefined;
}
