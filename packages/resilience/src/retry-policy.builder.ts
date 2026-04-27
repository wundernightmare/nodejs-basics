import type { ConfigService } from "@nestjs/config";

import { computeJitteredDelay, sleep } from "@base/resilient-client";

/**
 * Normalised retry policy shared across every downstream driver
 * (ClickHouse, ScyllaDB, Valkey, Kafka, outbound HTTP). The four knobs
 * are the minimum surface that allows an operator to reason about
 * worst-case recovery time without reading driver internals:
 *
 *   maxAttempts  — absolute retry cap (0 means "no retries, fail fast")
 *   baseDelayMs  — cap on the jitter window on the first retry
 *   maxDelayMs   — ceiling on the cap after exponential growth
 *   budgetMs     — wall-clock budget across the entire retry sequence;
 *                  `withRetry` stops honouring `maxAttempts` once the
 *                  budget is exhausted, which bounds the caller's
 *                  blocking time regardless of how many attempts remain.
 *
 * Driver-side policies (cassandra-driver, iovalkey, librdkafka, undici)
 * keep their own reconnect loops — this wrapper is for idempotent
 * *query* retries, not for connection establishment. Callers flip it on
 * per-call site where the semantics are known to be safe.
 */
export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly budgetMs: number;
}

/**
 * Read a normalised retry policy out of `<PREFIX>_RETRY_*` env keys. The
 * prefix is the same string the dependency's dedicated env surface uses
 * (e.g. `CH`, `CASSANDRA`, `VALKEY`) so every knob in the registry shares
 * one family name.
 *
 * Falls back to the defaults below when a key is unset or parses to a
 * non-finite number. The defaults were chosen so that the worst-case
 * wall-clock across retries (30 s) is well under the HTTP request
 * timeouts the app imposes on its callers (60 s+), and so a crashed
 * broker has time to recover a leader (~ 5 s is typical) before the
 * budget expires.
 */
export function buildRetryPolicy(
  config: ConfigService,
  prefix: string,
  defaults: RetryPolicy = DEFAULT_RETRY_POLICY,
): RetryPolicy {
  const readNum = (key: string, fallback: number): number => {
    const raw = config.get<string>(`${prefix}_${key}`);
    if (typeof raw !== "string" || raw.length === 0) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    maxAttempts: readNum("RETRY_MAX_ATTEMPTS", defaults.maxAttempts),
    baseDelayMs: readNum("RETRY_BASE_DELAY_MS", defaults.baseDelayMs),
    maxDelayMs: readNum("RETRY_MAX_DELAY_MS", defaults.maxDelayMs),
    budgetMs: readNum("RETRY_BUDGET_MS", defaults.budgetMs),
  };
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 5000,
  budgetMs: 30_000,
};

/**
 * Retry a promise-returning operation under a `RetryPolicy`.
 *
 * Each failure is fed to `isRetryable(err)`; when the predicate returns
 * `false`, the error is re-thrown immediately — critical for avoiding
 * double-writes on non-idempotent operations that happened to fail after
 * partial success. Default predicate: retry everything (callers pass a
 * driver-specific filter: e.g. Scylla `NoHostAvailableError`, Valkey
 * `ECONNREFUSED`, ClickHouse HTTP 5xx).
 *
 * Jitter is drawn from the shared `computeJitteredDelay` helper in
 * @base/resilient-client so the full-jitter curve is identical to the
 * one outbound HTTP already uses — one mental model, one place for tests.
 *
 * `onAttempt` fires after *every* failure (retryable or not) with the
 * attempt index, delay about to be slept, and error — enough context to
 * emit OpenTelemetry metrics without coupling the retry core to a
 * specific metric library. `rng` is injectable for deterministic tests.
 */
export interface WithRetryHooks {
  /** Called once per failure (including terminal). */
  onAttempt?: (ctx: { attempt: number; delayMs: number; error: unknown }) => void;
  /** Retry predicate. Defaults to "retry all". */
  isRetryable?: (error: unknown) => boolean;
  /** Deterministic RNG hook for tests. Defaults to Math.random. */
  rng?: () => number;
  /** Monotonic clock hook for tests. Defaults to Date.now. */
  now?: () => number;
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy,
  hooks: WithRetryHooks = {},
): Promise<T> {
  const isRetryable = hooks.isRetryable ?? (() => true);
  const rng = hooks.rng ?? Math.random;
  const now = hooks.now ?? Date.now;
  const startedAt = now();

  let attempt = 0;
  // The loop consumes attempts 0..maxAttempts inclusive — attempt=0 is
  // the original call (no preceding delay), attempt>=1 is a retry. Using
  // `<=` here instead of `<` means `maxAttempts=3` yields up to 3 retries
  // on top of the initial call, matching the plain-English reading of
  // the knob name.
  while (true) {
    try {
      return await operation();
    } catch (error) {
      const elapsed = now() - startedAt;
      const budgetExhausted = elapsed >= policy.budgetMs;
      const retryable = isRetryable(error);
      const attemptsExhausted = attempt >= policy.maxAttempts;

      if (!retryable || attemptsExhausted || budgetExhausted) {
        hooks.onAttempt?.({ attempt, delayMs: 0, error });
        throw error;
      }

      // `attempt` here is the number of prior retries — on the first
      // failure attempt=0 so the delay is drawn from [0, baseDelayMs];
      // on the second failure attempt=1, etc. Matches the AWS Full
      // Jitter contract in backoff.ts.
      const rawDelay = computeJitteredDelay(
        {
          minTimeout: policy.baseDelayMs,
          maxTimeout: policy.maxDelayMs,
          factor: 2,
        },
        attempt,
        rng,
      );
      // Never sleep past the remaining budget — otherwise a single
      // unlucky draw could hold the caller for the full max-delay even
      // though the budget should short-circuit.
      const remaining = Math.max(0, policy.budgetMs - elapsed);
      const delayMs = Math.min(rawDelay, remaining);

      hooks.onAttempt?.({ attempt, delayMs, error });
      await sleep(delayMs);
      attempt += 1;
    }
  }
}
