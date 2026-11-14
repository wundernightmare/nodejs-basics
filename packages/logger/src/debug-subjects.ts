/**
 * Debug subjects — "show me everything about tenant 42 for the next 15
 * minutes" without raising the log level for everyone. An operator lists a
 * subject (a tenant, a user: any id the service knows a request by) through
 * the admin listener; while it is listed, the service wraps that subject's
 * work in `withDebugSubject(id, fn)`, and inside it
 *   - every log line passes, whatever the level and the sampler say;
 *   - the active span carries `debug.subject=<id>` — the attribute the
 *     collector's tail sampling keeps a trace for (docker/otel-collector).
 *
 *   GET    /admin/debug-subjects                    the list, sorted
 *   PUT    /admin/debug-subjects/{subject}?ttl=15m  add or extend; ttl is required
 *   DELETE /admin/debug-subjects/{subject}          remove (idempotent)
 *
 * The list is per process (ask every replica) and bounded: at most 100
 * subjects, each with a TTL capped at LOG_LEVEL_MAX_TTL — nobody has to
 * remember to turn it off. An unlisted subject costs one map lookup.
 *
 * The service decides who the subject of a request is — after it has
 * authenticated the caller, never from a header anyone can set:
 *
 *   return withDebugSubject(user.tenantId, () => handler(request));
 *
 * Mirrors Server.DebugSubject in golang-basics' libs/httpx.
 */
import { trace } from "@opentelemetry/api";

import { withDebugLogging } from "@base/common";

import { formatDuration } from "./log-level.js";

/** The span attribute a debugged subject's spans carry. */
export const DEBUG_SUBJECT_ATTRIBUTE = "debug.subject";
/** Most subjects listed at once. */
export const MAX_DEBUG_SUBJECTS = 100;

export interface DebugSubjectEntry {
  subject: string;
  expires_at: string;
}

export interface DebugSubjectsState {
  subjects: DebugSubjectEntry[];
  max_ttl: string;
}

export class DebugSubjects {
  readonly #expiry = new Map<string, number>();

  constructor(
    /** The longest a subject stays listed, in ms (read at each use: it may be set late). */
    private readonly maxTtlMs: () => number,
    private readonly now: () => number = Date.now,
    private readonly max = MAX_DEBUG_SUBJECTS,
  ) {}

  /** Lists or extends a subject; false when the list is full of live entries. */
  put(subject: string, ttlMs: number): boolean {
    const now = this.now();
    if (!this.#expiry.has(subject)) {
      // A new subject needs room: expired ones give theirs up first.
      this.#sweep(now);
      if (this.#expiry.size >= this.max) return false;
    }
    this.#expiry.set(subject, now + Math.min(ttlMs, this.maxTtlMs()));
    return true;
  }

  remove(subject: string): void {
    this.#expiry.delete(subject);
  }

  clear(): void {
    this.#expiry.clear();
  }

  /**
   * Whether the subject is listed right now. Expiry is checked here — there
   * is no timer; an expired entry is dropped by the next put() or snapshot().
   */
  active(subject: string): boolean {
    return (this.#expiry.get(subject) ?? 0) > this.now();
  }

  snapshot(): DebugSubjectsState {
    this.#sweep(this.now());
    const subjects = [...this.#expiry]
      .map(([subject, expires]) => ({ subject, expires_at: new Date(expires).toISOString() }))
      // Map keys: no two subjects are equal.
      // Stryker disable next-line EqualityOperator: `<=` is the same order for distinct keys
      .toSorted((a, b) => (a.subject < b.subject ? -1 : 1));
    return { subjects, max_ttl: formatDuration(this.maxTtlMs()) };
  }

  #sweep(now: number): void {
    for (const [subject, expires] of this.#expiry) {
      if (expires <= now) this.#expiry.delete(subject);
    }
  }
}

/**
 * Runs fn as the work of `subject`. When the subject is listed in `subjects`,
 * fn runs with debug logging on and the active span is marked; otherwise fn
 * just runs.
 */
export function runAsDebugSubject<T>(
  subjects: DebugSubjects,
  subject: string | undefined,
  fn: () => T,
): T {
  // No subject is no subject — even if someone listed the empty string.
  if (!subject || !subjects.active(subject)) return fn();
  trace.getActiveSpan()?.setAttribute(DEBUG_SUBJECT_ATTRIBUTE, subject);
  return withDebugLogging(fn);
}
