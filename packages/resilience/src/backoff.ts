/** Full-jitter exponential backoff shared by every dependency client. */
import { setTimeout as delay } from "node:timers/promises";

export interface BackoffSpec {
  /** Cap of the first retry in ms; the actual wait is drawn from [0, minTimeout]. */
  minTimeout: number;
  /** Upper bound in ms, regardless of attempt count. */
  maxTimeout: number;
  /** Exponential growth factor between attempts. */
  factor: number;
}

/** A uniformly drawn delay in [0, min(minTimeout * factor**attempt, maxTimeout)]. */
export function computeJitteredDelay(
  spec: BackoffSpec,
  attempt: number,
  rng: () => number = Math.random,
): number {
  if (!Number.isFinite(spec.minTimeout) || !Number.isFinite(spec.maxTimeout)) return 0;
  if (attempt < 0) return 0;
  const rawCap = spec.minTimeout * Math.pow(spec.factor, attempt);
  // Zero times an overflowed factor is NaN, not zero.
  const cap = Number.isNaN(rawCap) ? 0 : Math.max(0, Math.min(rawCap, spec.maxTimeout));
  return Math.floor(rng() * cap);
}

/** Sleeps without scheduling a timer for a non-positive duration. */
export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return delay(ms);
}
