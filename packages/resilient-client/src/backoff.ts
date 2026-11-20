export { computeJitteredDelay, sleep, type BackoffSpec } from "@base/resilience";

/** Bounds a parsed Retry-After: nobody waits anywhere near this long. */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Reads a Retry-After header value — delay-seconds or an HTTP-date (RFC 9110
 * §10.2.3) — as ms from `now`. A date in the past is 0; a value that is
 * neither is undefined.
 */
export function parseRetryAfter(
  value: string | string[] | undefined,
  now: number = Date.now(),
): number | undefined {
  const text = (Array.isArray(value) ? value[0] : value)?.trim();
  if (text === undefined || text === "") return undefined;
  if (/^\d+$/u.test(text)) return Math.min(Number(text) * 1000, MAX_RETRY_AFTER_MS);
  // Only an HTTP-date: Date.parse alone would also take "1", "2026" and the like.
  if (!/^[A-Za-z]{3},? /u.test(text)) return undefined;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(at - now, 0), MAX_RETRY_AFTER_MS);
}
