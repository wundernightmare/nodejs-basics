import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Carries the x-request-id value for the current async request context.
 *
 * Set by an onRequest hook; consumed downstream (e.g. ResilientClient) to
 * forward the header on every outbound call made during the same request.
 */
export const requestIdStorage = new AsyncLocalStorage<string>();

/**
 * Stores the authenticated userId for the current async request context.
 * Set by an auth guard after successful token verification.
 * Falls back to "system" when no actor is set (background jobs, system operations).
 */
export const actorStorage = new AsyncLocalStorage<string>();

/**
 * Stores the active tenantId for the current async request context.
 * Set by a tenant middleware after tenant resolution.
 * Undefined on routes outside a tenant context.
 */
export const tenantStorage = new AsyncLocalStorage<string>();

/**
 * Runs fn with the given actorId in context — use this to override the actor
 * for a specific scope (e.g. invite-accept flows where the newly-created
 * userId acts on its own behalf without going through the auth guard).
 */
export function withActor<T>(actorId: string, fn: () => T): T {
  return actorStorage.run(actorId, fn);
}

export function withTenant<T>(tenantId: string, fn: () => T): T {
  return tenantStorage.run(tenantId, fn);
}

export function withRequestId<T>(requestId: string, fn: () => T): T {
  return requestIdStorage.run(requestId, fn);
}
