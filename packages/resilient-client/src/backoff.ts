/**
 * Full Jitter exponential back-off — AWS variant.
 *
 * Extracted from ResilientClient so the same curve can be reused by retry
 * wrappers around non-HTTP drivers (ClickHouse HTTP via the client, Scylla
 * binary protocol, Valkey RESP, Kafka producer/consumer policies). Keeping
 * one implementation means a single cap-behaviour contract, one place for
 * tests, and a single place to swap in a different jitter strategy later
 * without hunting every caller.
 *
 * Curve: delay ∈ [0, cap] where cap = min(minTimeout · factor^attempt,
 * maxTimeout). The uniform draw over the full window is what AWS calls
 * "Full Jitter"; it provably reduces herd effects compared to equal-jitter
 * or deterministic exponential backoff when a cluster of clients retries a
 * common downstream at once.
 *
 * The helper is RNG-injectable for deterministic tests. Production callers
 * omit the third argument and get `Math.random`.
 */

export interface BackoffSpec {
  /**
   * Minimum delay ceiling in ms when attempt=0 (i.e. the first retry).
   * The actual wait is drawn uniformly from [0, minTimeout] on attempt 0.
   */
  minTimeout: number;
  /** Upper bound on the computed delay in ms, regardless of attempt count. */
  maxTimeout: number;
  /**
   * Multiplicative growth factor between attempts. `2` doubles the cap
   * each attempt (AWS default). Values below 1 collapse to a flat cap
   * of `minTimeout` — legal but rarely useful.
   */
  factor: number;
}

/**
 * Compute a jittered delay in ms for the given attempt number.
 *
 * `attempt` is zero-indexed: attempt 0 is the first retry (after the
 * initial call failed), attempt 1 the second, and so on.
 *
 * Negative attempt numbers and non-finite `minTimeout` / `maxTimeout`
 * values collapse to `0` — they signal a misconfigured policy, and
 * sleeping forever or burning CPU on `Infinity` is worse than returning
 * immediately and letting the caller's retry-budget decide whether to
 * try again.
 */
export function computeJitteredDelay(
  spec: BackoffSpec,
  attempt: number,
  rng: () => number = Math.random,
): number {
  if (!Number.isFinite(spec.minTimeout) || !Number.isFinite(spec.maxTimeout)) return 0;
  if (attempt < 0) return 0;
  const rawCap = spec.minTimeout * Math.pow(spec.factor, attempt);
  const cap = Math.max(0, Math.min(rawCap, spec.maxTimeout));
  return Math.floor(rng() * cap);
}

/**
 * Sleep helper keyed to the same semantics as `computeJitteredDelay`:
 * non-positive durations resolve on the next microtask instead of
 * scheduling a zero-delay timer. Keeps call sites free of guard code
 * and lets retry loops short-circuit on degenerate policies.
 */
export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
