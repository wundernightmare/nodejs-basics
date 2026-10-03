import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Carries the x-request-id value for the current async request context.
 *
 * Set by an onRequest hook; consumed downstream (e.g. ResilientClient) to
 * forward the header on every outbound call made during the same request.
 */
export const requestIdStorage = new AsyncLocalStorage<string>();

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
  return (
    typeof value === "string" && value.length <= MAX_REQUEST_ID_LEN && /^[!-~]+$/u.test(value) // "!" 0x21 … "~" 0x7e
  );
}
