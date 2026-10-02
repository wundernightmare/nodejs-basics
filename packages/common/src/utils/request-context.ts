import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Carries the x-request-id value for the current async request context.
 *
 * Set by an onRequest hook; consumed downstream (e.g. ResilientClient) to
 * forward the header on every outbound call made during the same request.
 */
export const requestIdStorage = new AsyncLocalStorage<string>();

/** Who the current request acts as — filled in once auth has run. */
export interface RequestIdentity {
  /** The authenticated principal (user id, client id). */
  actor?: string;
  /** The tenant the request is scoped to, on multi-tenant routes. */
  tenant?: string;
}

/**
 * One mutable identity object per request, entered by the onRequest hook.
 *
 * Mutable on purpose: an auth guard runs *inside* the request and cannot wrap
 * the handler in `storage.run()`, and `enterWith()` from a guard does not
 * reach the handler (Nest awaits the guard in its own async frame; on Node 24
 * the value set there is gone by the time the handler runs). Writing a field
 * of the object the hook entered is visible to everything after it.
 */
export const identityStorage = new AsyncLocalStorage<RequestIdentity>();

/**
 * Marks the current async context as "debug this unit of work": every log
 * line emitted under it passes regardless of the runtime log level. Set for
 * one request by the X-Debug-Token hook, or for one message by a worker.
 */
export const debugLoggingStorage = new AsyncLocalStorage<boolean>();

/** Request header / response header names of the request-id contract. */
export const REQUEST_ID_HEADER = "x-request-id";
/** Request header that turns on debug logging for one request (see DEBUG_TOKEN). */
export const DEBUG_TOKEN_HEADER = "x-debug-token";
/** Response header set when the debug token was accepted: "on". */
export const DEBUG_LOGGING_HEADER = "x-debug-logging";

/** Upper bound for an inbound request id — it is echoed and logged. */
const MAX_REQUEST_ID_LEN = 128;

/**
 * Record the authenticated actor for the rest of the request — call it from
 * an auth guard. Returns false outside a request (nothing to write to).
 */
export function setActor(actorId: string): boolean {
  const identity = identityStorage.getStore();
  if (identity === undefined) return false;
  identity.actor = actorId;
  return true;
}

/** Record the request's tenant (tenant resolution guard/middleware). See setActor. */
export function setTenant(tenantId: string): boolean {
  const identity = identityStorage.getStore();
  if (identity === undefined) return false;
  identity.tenant = tenantId;
  return true;
}

/** The current identity (read-only copy), empty outside a request. */
export function getIdentity(): Readonly<RequestIdentity> {
  return { ...identityStorage.getStore() };
}

/**
 * Runs fn as another actor — a scope that acts on someone's behalf without
 * going through the guard (a job, a system action). The outer identity is
 * left untouched.
 */
export function withActor<T>(actorId: string, fn: () => T): T {
  return identityStorage.run({ ...identityStorage.getStore(), actor: actorId }, fn);
}

export function withTenant<T>(tenantId: string, fn: () => T): T {
  return identityStorage.run({ ...identityStorage.getStore(), tenant: tenantId }, fn);
}

export function withRequestId<T>(requestId: string, fn: () => T): T {
  return requestIdStorage.run(requestId, fn);
}

/** The request id of the current async context, or undefined outside one. */
export function getRequestId(): string | undefined {
  return requestIdStorage.getStore();
}

/**
 * Runs fn with debug logging on for its whole async continuation — the
 * "debug this request/message" switch, not a level. Cheap: one ALS frame.
 */
export function withDebugLogging<T>(fn: () => T): T {
  return debugLoggingStorage.run(true, fn);
}

/** Whether the current async context was marked by withDebugLogging(). */
export function isDebugLogging(): boolean {
  return debugLoggingStorage.getStore() === true;
}

/**
 * A client-supplied request id is honoured when it is 1–128 printable,
 * non-space ASCII characters — enough for every id scheme in use (UUID,
 * ULID, hex, base32) and nothing that could break a log line or a header.
 */
export function isValidRequestId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_REQUEST_ID_LEN) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x20 || c > 0x7e) return false;
  }
  return true;
}
