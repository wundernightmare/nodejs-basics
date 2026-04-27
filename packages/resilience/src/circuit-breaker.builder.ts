/**
 * Shared circuit-breaker primitive for DB / cache / broker clients.
 *
 * `@base/resilient-client` already wraps every outbound HTTP call in
 * opossum — the HTTP paths therefore fast-fail within 5 s when a
 * downstream is dead and stop hammering it while the breaker is open.
 * The storage drivers (pg, cassandra-driver, iovalkey, librdkafka) did
 * not have an equivalent, so a totally-dead Postgres primary or Valkey
 * cluster would retry every request up to the `withRetry` budget, chew
 * through pool slots, and tail-latency an entire replica set into
 * timing out instead of 503-ing cleanly.
 *
 * This module exposes one `DependencyCircuitBreaker` per storage
 * dependency. The breaker tracks a sliding error window across all
 * callers that share the instance; opening it once fast-fails every
 * subsequent call with `ServiceUnavailableException` until the reset
 * timeout elapses and opossum lets through a single half-open probe.
 *
 * Intentional scope limit: this is NOT an app-level retry — callers
 * that want retries still go through `withRetry(action, policy)`. The
 * two compose naturally: wrap `withRetry` inside `breaker.execute`, or
 * the other way round depending on whether you want retries to count
 * against the breaker's error budget (inside → yes, outside → no).
 */
import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import CircuitBreaker from "opossum";

/**
 * Normalised breaker config shared across every store. The four knobs
 * cover the full opossum surface — `timeout` protects against hung
 * calls (per-action watchdog), `errorThresholdPercentage` +
 * `volumeThreshold` decide when to open, `resetTimeout` decides how
 * long to stay open before a half-open probe. `enabled=false` turns
 * the breaker into a pass-through (still runs actions, no tripping) —
 * used to opt out per-dependency in dev or during incident triage.
 */
export interface CircuitBreakerConfig {
  /** Pass-through when false — the wrapped fn runs directly. */
  enabled: boolean;
  /** Per-action watchdog timeout in ms (opossum counts timeouts as failures). */
  timeoutMs: number;
  /** Error-rate percentage that trips the breaker once volume is reached. */
  errorThresholdPct: number;
  /** Minimum observed calls in the rolling window before the breaker can trip. */
  volumeThreshold: number;
  /** How long the breaker stays open before letting a half-open probe through. */
  resetTimeoutMs: number;
}

export const DEFAULT_CIRCUIT_BREAKER: CircuitBreakerConfig = {
  enabled: true,
  // DB calls inherit pool-level query_timeout already; the breaker's
  // timeout is a safety net for calls that slip past the driver's own
  // budget (deadlocked idle connection, infinite blocking command, etc).
  timeoutMs: 30_000,
  // 50% failed requests in the window is the AWS default. Higher → more
  // noise tolerated before fast-fail kicks in; lower → more
  // trigger-happy, more 503 storms on flaky-but-recovering stores.
  errorThresholdPct: 50,
  // Prevents a single outage-adjacent error from tripping on a
  // low-traffic pod. `10` matches the resilient-client HTTP default.
  volumeThreshold: 10,
  // 30 s aligns with the typical retry budget — by the time a
  // withRetry sequence has exhausted itself, the breaker will have
  // considered another half-open probe.
  resetTimeoutMs: 30_000,
};

export function buildCircuitBreaker(
  config: ConfigService,
  prefix: string,
  defaults: CircuitBreakerConfig = DEFAULT_CIRCUIT_BREAKER,
): CircuitBreakerConfig {
  const readNum = (key: string, fallback: number): number => {
    const raw = config.get<string>(`${prefix}_${key}`);
    if (typeof raw !== "string" || raw.length === 0) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const readBool = (key: string, fallback: boolean): boolean => {
    const raw = config.get<string>(`${prefix}_${key}`);
    if (typeof raw !== "string" || raw.length === 0) return fallback;
    return raw === "true" || raw === "1";
  };
  return {
    enabled: readBool("CB_ENABLED", defaults.enabled),
    timeoutMs: readNum("CB_TIMEOUT_MS", defaults.timeoutMs),
    errorThresholdPct: readNum("CB_ERROR_THRESHOLD_PCT", defaults.errorThresholdPct),
    volumeThreshold: readNum("CB_VOLUME_THRESHOLD", defaults.volumeThreshold),
    resetTimeoutMs: readNum("CB_RESET_TIMEOUT_MS", defaults.resetTimeoutMs),
  };
}

/**
 * Wraps one dependency's calls in a single opossum breaker.
 *
 * Caller pattern:
 *   const breaker = new DependencyCircuitBreaker("postgres", cfg);
 *   const rows = await breaker.execute(() => pool.query(...));
 *
 * `execute` is a thin passthrough over `opossum.fire(action)`. opossum
 * rewraps the action as a stored `action` function at construction
 * time; we give it a single generic `(fn) => fn()` trampoline so each
 * `execute` call can supply a different action without constructing
 * a new breaker. Callers that want an errorFilter (e.g. ignore 404s
 * from a data-delete) pass it in the options.
 */
@Injectable()
export class DependencyCircuitBreaker {
  readonly #name: string;
  readonly #enabled: boolean;
  readonly #breaker?: CircuitBreaker<[() => Promise<unknown>], unknown>;

  constructor(
    name: string,
    cfg: CircuitBreakerConfig,
    opts: { errorFilter?: (err: unknown) => boolean } = {},
  ) {
    this.#name = name;
    this.#enabled = cfg.enabled;
    if (!cfg.enabled) return;

    this.#breaker = new CircuitBreaker(async (action: () => Promise<unknown>) => action(), {
      name,
      timeout: cfg.timeoutMs,
      errorThresholdPercentage: cfg.errorThresholdPct,
      volumeThreshold: cfg.volumeThreshold,
      resetTimeout: cfg.resetTimeoutMs,
      // opossum asks whether an error should count towards the
      // breaker's error rate. The default library behaviour counts
      // everything; we invert per the passed predicate so operators
      // can whitelist 404-as-expected-result kinds of errors.
      errorFilter: opts.errorFilter ?? ((): boolean => false),
    });
  }

  /**
   * Run `action` under the breaker. When the breaker is open, rejects
   * immediately with `ServiceUnavailableException` — no action is run,
   * no pool slot is consumed. When closed or half-open, runs and
   * records the outcome towards the rolling window.
   *
   * On `enabled=false` this is a pure passthrough (no latency, no
   * bookkeeping) so turning off the breaker is zero-overhead.
   */
  async execute<T>(action: () => Promise<T>): Promise<T> {
    if (!this.#enabled || !this.#breaker) return action();
    try {
      return (await this.#breaker.fire(action)) as T;
    } catch (err) {
      // opossum rejects with the original action error on run failures,
      // but rejects with a custom shape when the breaker short-circuits
      // ('Breaker is open' string). Translate the latter to a typed
      // ServiceUnavailable so HTTP handlers surface it as a clean 503.
      if (err instanceof Error && /breaker is open/i.test(err.message)) {
        throw new ServiceUnavailableException(`${this.#name} circuit breaker open`);
      }
      throw err;
    }
  }

  /** Current breaker state — "closed" | "open" | "halfOpen" | "disabled". */
  state(): "closed" | "open" | "halfOpen" | "disabled" {
    if (!this.#breaker) return "disabled";
    if (this.#breaker.opened) return "open";
    if (this.#breaker.halfOpen) return "halfOpen";
    return "closed";
  }

  /** Dispose — clears opossum's internal timers so tests don't leak. */
  shutdown(): void {
    this.#breaker?.shutdown();
  }
}
