import Bottleneck from "bottleneck";
import CircuitBreaker from "opossum";
import { Client, Pool } from "undici";
import type { Dispatcher } from "undici";

import { computeJitteredDelay, parseRetryAfter, sleep } from "./backoff.js";
import { CachedBodyReadable } from "./resilient-client.cache.js";
import type { CacheConfig, CachedEntry } from "./resilient-client.cache.js";
import { OutboundError } from "./resilient-client.errors.js";
import { RetryBudget } from "./retry-budget.js";
import type { RetryBudgetConfig } from "./retry-budget.js";

/** The abort AbortSignal.timeout() causes (undici rejects with its reason, a TimeoutError). */
function isTimeoutAbort(err: unknown): boolean {
  const e = err as { name?: unknown; cause?: { name?: unknown } } | null;
  return e?.name === "TimeoutError" || e?.cause?.name === "TimeoutError";
}

/**
 * The request, or the signal's reason as soon as the signal fires — whichever
 * comes first. undici honours the signal once a request is on a connection;
 * while the connection is still being made (a SYN nobody answers, a TLS
 * handshake that hangs) the request waits for the connect timeout whatever
 * the signal says. The attempt timeout and the caller's budget are promises
 * about how long the CALLER waits, so the wait ends here; a response that
 * still arrives afterwards is discarded.
 */
function endingWith(
  signal: AbortSignal | undefined,
  request: Promise<Dispatcher.ResponseData>,
): Promise<Dispatcher.ResponseData> {
  if (signal === undefined) return request;
  return new Promise<Dispatcher.ResponseData>((resolve, reject) => {
    let abandoned = false;
    const onAbort = (): void => {
      abandoned = true;
      // The signal's own reason (a TimeoutError, the caller's abort reason).
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new Error("aborted", { cause: reason }));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    request.then(
      (response) => {
        signal.removeEventListener("abort", onAbort);
        if (abandoned) {
          response.body.on("error", () => {});
          response.body.destroy();
        } else resolve(response);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        if (!abandoned) reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** undici's own default for making a connection, the ceiling of ours. */
const CONNECT_TIMEOUT_MS = 10_000;

/** Methods that may be sent more than once (RFC 9110 §9.2.2). */
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "OPTIONS",
  "PUT",
  "DELETE",
]);

/** A body the client can send again: nothing, text or bytes — not a stream or an iterator. */
function isReplayable(body: Dispatcher.RequestOptions["body"]): boolean {
  return (
    body === null || body === undefined || typeof body === "string" || ArrayBuffer.isView(body)
  );
}

/** "Try again" statuses — the rule golang-basics' client uses: 408, 425, 429, 5xx but 501 and 505. */
const RETRY_STATUS_CODES = [408, 425, 429, 500, 502, 503, 504];

export type BreakerState = "closed" | "open" | "halfOpen";

// ─── Logger interface ─────────────────────────────────────────────────────────

/** Minimal logger interface compatible with pino, console, and no-ops. */
export interface Logger {
  info(obj: Record<string, unknown>, msg: string): void;
  info(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

// ─── Config types ─────────────────────────────────────────────────────────────

export interface RetryConfig {
  /** Max retry attempts on transient failures. Default: 2 (fast-only). */
  maxRetries?: number;
  /** Initial delay ms before first retry. Default: 50 */
  minTimeout?: number;
  /** Max delay cap ms. Default: 200 — intentionally low; long retries belong in Kafka. */
  maxTimeout?: number;
  /** Multiplier per retry. Default: 2 */
  timeoutFactor?: number;
  /**
   * HTTP status codes that mean "try again". Default: 408, 425, 429, 500, 502,
   * 503, 504. Such a response is never returned: it is retried, or it ends the
   * call with OutboundError.retriesExhausted.
   */
  statusCodes?: number[];
  /** Node.js / undici error codes that trigger a retry (connection errors). */
  errorCodes?: string[];
  /**
   * Caps retries at `minRetries + ratio × requests` per window, so an outage
   * cannot multiply the traffic by the attempt count. Default: 0.2 × requests
   * + 10 per 10 s; `false` disables it.
   */
  budget?: RetryBudgetConfig | false;
}

export interface RateLimitConfig {
  /** Initial token count (Bottleneck reservoir). */
  reservoir?: number;
  /** Tokens added per refresh interval. */
  reservoirRefreshAmount?: number;
  /** Interval ms between reservoir refills. */
  refreshInterval?: number;
  /** Max concurrent in-flight requests. */
  maxConcurrent?: number;
  /** Min ms between job executions. */
  minTime?: number;
  /**
   * When true: if the reservoir is empty, reject immediately with a Transient error
   * instead of queuing. Useful for postback workers that push back to Kafka.
   * Default: false (queue behaviour).
   */
  rejectOnRateLimit?: boolean;
}

export interface CircuitBreakerConfig {
  /**
   * A timeout over the whole call (queueing and retries included). It does not
   * cancel anything — the call goes on in the background and counts as a
   * failure — so it is off by default: `attemptTimeoutMs` bounds each attempt
   * and `getRemainingMs` the call. Default: false.
   */
  timeout?: number | false;
  /** % of failures required to trip the breaker. Default: 50 */
  errorThresholdPercentage?: number;
  /** Time ms to wait before attempting recovery. Default: 30_000 */
  resetTimeout?: number;
  /** Min requests before the breaker can trip. Default: 5 */
  volumeThreshold?: number;
}

/**
 * Invoked when the circuit breaker is open or all retries are exhausted.
 * Return a synthetic `Dispatcher.ResponseData` to serve in place of the error,
 * or `null` to propagate the original `OutboundError`.
 */
export type FallbackFn = (
  url: string,
  opts: Dispatcher.RequestOptions,
  reason: OutboundError,
) => Promise<Dispatcher.ResponseData | null>;

/**
 * AIMD (Additive Increase / Multiplicative Decrease) adaptive concurrency config.
 *
 * Algorithm:
 *   - On success with RTT ≤ minObservedRtt × targetRttFactor → limit += 1
 *   - On success with RTT > target, or on any failure               → limit *= backoffFactor
 *
 * This replaces the static `maxConcurrent` in `RateLimitConfig` when enabled.
 */
export interface AdaptiveConcurrencyConfig {
  /** Enable adaptive concurrency. Default: false */
  enabled?: boolean;
  /** Starting concurrency limit. Default: 10 */
  initialLimit?: number;
  /** Minimum concurrency floor. Default: 1 */
  minLimit?: number;
  /** Maximum concurrency ceiling. Default: 200 */
  maxLimit?: number;
  /**
   * Multiplicative decrease factor applied on error or high latency. Default: 0.9
   * e.g. 0.9 shrinks the limit to 90 % of its current value.
   */
  backoffFactor?: number;
  /**
   * Ratio of min-observed RTT above which the limit stops growing. Default: 2.0
   * Allow up to 2× no-load RTT before backing off.
   */
  targetRttFactor?: number;
}

export interface ResilientClientConfig {
  /**
   * > 1 → Pool (connection pool), === 1 → Client (single connection).
   * Default: 10
   */
  connections?: number;
  /** HTTP pipelining depth. Default: 1 */
  pipelining?: number;
  /** Keep-alive socket timeout ms. */
  keepAliveTimeout?: number;
  /** Forces `Connection: close` on every request. */
  shortLived?: boolean;
  /**
   * How long one attempt may take, from sending the request to the end of the
   * response body; the attempt is cancelled (an AbortSignal) and, when the
   * request may be repeated, retried. `false` disables it. Default: 5_000.
   */
  attemptTimeoutMs?: number | false;
  /**
   * Retries. Only a request that may be sent twice is retried: GET, HEAD,
   * OPTIONS, PUT, DELETE, or any method with an `Idempotency-Key` header — and
   * only when its body can be replayed (text or bytes, not a stream). The wait
   * is the jittered backoff or the response's Retry-After, whichever is longer;
   * a Retry-After beyond `maxTimeout`, a delay beyond the caller's budget or a
   * spent retry budget ends the call instead.
   */
  retry?: RetryConfig;
  rateLimit?: RateLimitConfig;
  /**
   * The breaker counts what the dependency did: connection errors, timeouts
   * and "try again" statuses that survived the retries. A 4xx, a rate-limit
   * rejection, a budget spent before sending and the caller's own abort are
   * not its failures.
   */
  circuitBreaker?: CircuitBreakerConfig;
  /** Override the User-Agent header for every request. */
  userAgent?: string;
  /**
   * Response caching for idempotent (GET/HEAD by default) requests.
   * When enabled the response body is buffered into memory before returning,
   * so callers receive a fully-readable `CachedBodyReadable` instead of a live stream.
   */
  cache?: CacheConfig;
  /**
   * Deduplicate concurrent in-flight GET/HEAD requests with the same path
   * (SingleFlight / request coalescing).  Only one upstream request is made;
   * concurrent waiters receive the same resolved value.  Default: false.
   */
  coalesce?: boolean;
  /**
   * Invoked when the circuit breaker is open or all retries are exhausted.
   * Return a synthetic response to serve as a fallback, or null to re-throw.
   */
  fallback?: FallbackFn;
  /**
   * Replace the static Bottleneck `maxConcurrent` with an AIMD-adaptive limit
   * that adjusts based on observed upstream RTT.
   */
  adaptiveConcurrency?: AdaptiveConcurrencyConfig;
  /**
   * When true, 4xx responses are returned to the caller instead of throwing
   * OutboundError. Useful for API clients that need to inspect 4xx response bodies.
   * Default: false.
   */
  passthrough4xx?: boolean;
  /**
   * Optional getter for a correlation / request ID to forward as X-Request-Id.
   * In NestJS: `() => requestIdStorage.getStore()`.
   * Default: not forwarded.
   */
  getRequestId?: () => string | undefined;
  /**
   * Optional getter for the caller's remaining budget in ms (the request
   * deadline). In the apps: `remainingMs` from @base/common. Each attempt then
   * gets at most that long (an AbortSignal — the request is really cancelled),
   * sends it on as `x-request-timeout-ms` so the next service can budget too,
   * and a spent budget fails fast with OutboundError.deadlineExceeded — never
   * retried. Default: no deadline.
   */
  getRemainingMs?: () => number | undefined;
  /**
   * TLS options forwarded to undici's `Client`/`Pool` `connect` callback.
   * Used when the base URL is `https://…` and the operator needs to override
   * CA bundle, disable hostname verification for dev-only self-signed certs,
   * or pin a specific certificate. Leaving unset keeps undici's own defaults
   * (system CA store + hostname verification enabled).
   *
   * Provide the standard Node.js `tls.ConnectionOptions` shape:
   *   { ca: Buffer | string | Array<Buffer | string>,
   *     rejectUnauthorized: boolean,
   *     servername: string, ... }
   *
   * For plaintext HTTP (non-TLS) the field is ignored.
   */
  tls?: {
    ca?: Buffer | string | Array<Buffer | string>;
    rejectUnauthorized?: boolean;
    servername?: string;
    [key: string]: unknown;
  };
  /** @internal Inject a pre-built Dispatcher (e.g. MockPool) for unit tests. */
  _dispatcher?: Dispatcher;
}

// ─── Internal: adaptive concurrency limiter ───────────────────────────────────

/**
 * Promise-based semaphore with AIMD limit adjustment.
 * acquire() blocks when #inFlight >= #limit; release() decrements and wakes waiters.
 */
class AdaptiveConcurrencyLimiter {
  #limit: number;
  readonly #minLimit: number;
  readonly #maxLimit: number;
  readonly #backoffFactor: number;
  readonly #targetRttFactor: number;
  #inFlight = 0;
  #minRtt = Infinity;
  readonly #waiters: Array<() => void> = [];

  constructor(cfg: AdaptiveConcurrencyConfig) {
    this.#limit = cfg.initialLimit ?? 10;
    this.#minLimit = cfg.minLimit ?? 1;
    this.#maxLimit = cfg.maxLimit ?? 200;
    this.#backoffFactor = cfg.backoffFactor ?? 0.9;
    this.#targetRttFactor = cfg.targetRttFactor ?? 2.0;
  }

  get currentLimit(): number {
    return this.#limit;
  }
  get inFlight(): number {
    return this.#inFlight;
  }

  async acquire(): Promise<void> {
    // Re-check after each wakeup — another acquire() may have raced ahead.
    while (true) {
      if (this.#inFlight < this.#limit) {
        this.#inFlight++;
        return;
      }
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
      });
    }
  }

  release(rttMs: number, failed: boolean): void {
    this.#inFlight--;
    if (failed) {
      this.#decrease();
    } else {
      if (rttMs < this.#minRtt) this.#minRtt = rttMs;
      const target = this.#minRtt * this.#targetRttFactor;
      if (rttMs <= target) {
        this.#limit = Math.min(this.#limit + 1, this.#maxLimit);
      } else {
        this.#decrease();
      }
    }
    this.#drainWaiters();
  }

  /** Give a slot back without an observation (the attempt never went out). */
  cancel(): void {
    this.#inFlight--;
    this.#drainWaiters();
  }

  #decrease(): void {
    this.#limit = Math.max(Math.ceil(this.#limit * this.#backoffFactor), this.#minLimit);
  }

  #drainWaiters(): void {
    while (this.#waiters.length > 0 && this.#inFlight < this.#limit) {
      const resolve = this.#waiters.shift()!;
      resolve();
    }
  }
}

// ─── ResilientClient ──────────────────────────────────────────────────────────

/**
 * Single-target resilient HTTP client.
 * Manages one connection pool + one rate limiter + one circuit breaker.
 * Used directly for a fixed base URL, or as the building block inside `ResilientPool`.
 */
export class ResilientClient {
  readonly #dispatcher: Dispatcher;
  readonly #limiter: Bottleneck;
  readonly #breaker: CircuitBreaker<[Dispatcher.RequestOptions], Dispatcher.ResponseData>;
  readonly #shortLived: boolean;
  readonly #retryStatusCodes: ReadonlySet<number>;
  #retries = 0;
  #retryBudgetExhausted = 0;
  readonly #budget: RetryBudget | undefined;
  readonly #attemptTimeoutMs: number | undefined;
  /** Errors that say nothing about the dependency: the breaker does not count them. */
  readonly #benign = new WeakSet<object>();
  #lastState: BreakerState = "closed";
  readonly #transitions = new Map<
    string,
    { from: BreakerState; to: BreakerState; count: number }
  >();
  readonly #retryErrorCodes: ReadonlySet<string>;
  readonly #rejectOnRateLimit: boolean;
  readonly #maxRetries: number;
  readonly #minTimeout: number;
  readonly #maxTimeout: number;
  readonly #timeoutFactor: number;
  readonly #userAgent: string | undefined;
  readonly #cacheConfig: CacheConfig | undefined;
  readonly #coalesce: boolean;
  readonly #fallback: FallbackFn | undefined;
  readonly #passthrough4xx: boolean;
  readonly #adaptiveLimiter: AdaptiveConcurrencyLimiter | undefined;
  readonly #inflightMap = new Map<string, Promise<Dispatcher.ResponseData>>();

  constructor(
    private readonly baseUrl: string,
    private readonly config: ResilientClientConfig = {},
  ) {
    this.#shortLived = config.shortLived ?? false;
    this.#rejectOnRateLimit = config.rateLimit?.rejectOnRateLimit ?? false;

    this.#maxRetries = config.retry?.maxRetries ?? 2;
    this.#minTimeout = config.retry?.minTimeout ?? 50;
    this.#maxTimeout = config.retry?.maxTimeout ?? 200;
    this.#timeoutFactor = config.retry?.timeoutFactor ?? 2;

    const budget = config.retry?.budget;
    this.#budget = budget === false || budget?.windowMs === 0 ? undefined : new RetryBudget(budget);
    const attemptTimeout = config.attemptTimeoutMs ?? 5_000;
    this.#attemptTimeoutMs = attemptTimeout === false ? undefined : attemptTimeout;

    this.#retryStatusCodes = new Set(config.retry?.statusCodes ?? RETRY_STATUS_CODES);
    this.#retryErrorCodes = new Set(
      config.retry?.errorCodes ?? [
        "ECONNRESET",
        "ECONNREFUSED",
        "ENOTFOUND",
        "ENETDOWN",
        "ENETUNREACH",
        "EHOSTDOWN",
        "EHOSTUNREACH",
        "EPIPE",
        "ETIMEDOUT",
        "UND_ERR_SOCKET",
        "UND_ERR_CONNECT_TIMEOUT",
      ],
    );

    this.#userAgent = config.userAgent;
    this.#cacheConfig = config.cache;
    this.#coalesce = config.coalesce ?? false;
    this.#fallback = config.fallback;
    this.#passthrough4xx = config.passthrough4xx ?? false;
    this.#adaptiveLimiter =
      config.adaptiveConcurrency?.enabled === true
        ? new AdaptiveConcurrencyLimiter(config.adaptiveConcurrency)
        : undefined;

    this.#dispatcher = config._dispatcher ?? this.#buildDispatcher();
    this.#limiter = this.#buildLimiter();
    this.#breaker = this.#buildCircuitBreaker();
  }

  /** Retries sent so far (attempts after the first) — http_client_retries_total. */
  get retries(): number {
    return this.#retries;
  }

  /** Retries the budget refused — http_client_retry_budget_exhausted_total. */
  get retryBudgetExhausted(): number {
    return this.#retryBudgetExhausted;
  }

  /** Breaker state changes so far — http_client_circuit_breaker_transitions_total. */
  get breakerTransitions(): Array<{ from: BreakerState; to: BreakerState; count: number }> {
    return [...this.#transitions.values()].map(({ from, to, count }) => ({ from, to, count }));
  }

  /** Current circuit breaker state. */
  get breakerState(): BreakerState {
    if (this.#breaker.opened) return "open";
    if (this.#breaker.halfOpen) return "halfOpen";
    return "closed";
  }

  /** Current adaptive concurrency limit, or undefined when not enabled. */
  get adaptiveLimit(): number | undefined {
    return this.#adaptiveLimiter?.currentLimit;
  }

  /**
   * Executes an HTTP request through the full resiliency stack:
   *   [Cache] → [Coalesce] → Circuit Breaker → Rate Limiter →
   *   [Adaptive Semaphore] → Retry → Dispatcher → [Cache Write]
   *   → [Fallback on error]
   */
  async request(options: Dispatcher.RequestOptions): Promise<Dispatcher.ResponseData> {
    const opts = this.#applyUserAgent(this.#applyShortLived(this.#forwardRequestId(options)));

    // Idempotent key — defined only for GET/HEAD when cache or coalescing is active.
    const key = this.#idempotentKey(opts);

    // 1. Cache hit
    if (key !== undefined && key !== "" && this.#cacheConfig) {
      const hit = await this.#tryCacheHit(key, opts);
      if (hit) return hit;
    }

    // 2. SingleFlight coalescing — attach to an existing in-flight promise
    if (key !== undefined && key !== "" && this.#coalesce) {
      const inflight = this.#inflightMap.get(key);
      if (inflight) return inflight;
    }

    // 3. Issue the request (optionally register with the inflight map)
    const promise = this.#executeRequest(opts, key);

    if (key !== undefined && key !== "" && this.#coalesce) {
      this.#inflightMap.set(key, promise);
      void promise.finally(() => {
        this.#inflightMap.delete(key);
      });
    }

    try {
      return await promise;
    } catch (err) {
      // 4. Fallback on OutboundError
      if (this.#fallback && err instanceof OutboundError) {
        const synthetic = await this.#fallback(this.baseUrl, opts, err).catch(() => null);
        if (synthetic !== null) return synthetic;
      }
      throw err;
    }
  }

  /** Closes the underlying pool and stops the rate limiter. */
  async close(): Promise<void> {
    await Promise.all([this.#dispatcher.close(), this.#limiter.stop({ dropWaitingJobs: false })]);
    this.#breaker.shutdown();
  }

  // ─── Private builders ────────────────────────────────────────────────────

  #buildDispatcher(): Client | Pool {
    const { connections = 10, pipelining = 1, keepAliveTimeout, shortLived, tls } = this.config;

    const clientOptions: Client.Options = {
      pipelining,
      ...(keepAliveTimeout === undefined ? {} : { keepAliveTimeout }),
      ...(shortLived === true ? { keepAliveMaxTimeout: 0 } : {}),
      // TLS options are only consulted when the base URL is https://.
      // The attempt timeout bounds making the connection too: a socket that
      // cannot be connected within it is closed, not left to undici's 10 s.
      connect: {
        ...(tls && this.baseUrl.startsWith("https://") ? tls : {}),
        timeout: Math.min(this.#attemptTimeoutMs ?? CONNECT_TIMEOUT_MS, CONNECT_TIMEOUT_MS),
      },
    };

    return connections > 1
      ? new Pool(this.baseUrl, { ...clientOptions, connections })
      : new Client(this.baseUrl, clientOptions);
  }

  #buildLimiter(): Bottleneck {
    const rl = this.config.rateLimit ?? {};
    return new Bottleneck({
      maxConcurrent: rl.maxConcurrent ?? null,
      minTime: rl.minTime ?? 0,
      reservoir: rl.reservoir ?? null,
      reservoirRefreshAmount: rl.reservoirRefreshAmount ?? null,
      reservoirRefreshInterval: rl.refreshInterval ?? null,
    });
  }

  #buildCircuitBreaker(): CircuitBreaker<[Dispatcher.RequestOptions], Dispatcher.ResponseData> {
    const cb = this.config.circuitBreaker ?? {};

    const action = (opts: Dispatcher.RequestOptions): Promise<Dispatcher.ResponseData> => {
      if (this.#rejectOnRateLimit) {
        return this.#limiter.schedule({ expiration: 0 }, () => this.#executeWithRetry(opts));
      }
      return this.#limiter.schedule(() => this.#executeWithRetry(opts));
    };

    const breaker = new CircuitBreaker(action, {
      timeout: cb.timeout ?? false,
      errorThresholdPercentage: cb.errorThresholdPercentage ?? 50,
      resetTimeout: cb.resetTimeout ?? 30_000,
      volumeThreshold: cb.volumeThreshold ?? 5,
      // opossum has no neutral outcome: what is not the dependency's fault counts as a success.
      errorFilter: (err: unknown) =>
        (typeof err === "object" && err !== null && this.#benign.has(err)) ||
        (err as { name?: unknown } | null)?.name === "BottleneckError",
    });

    const moved = (to: BreakerState) => (): void => {
      const from = this.#lastState;
      if (from === to) return;
      this.#lastState = to;
      const key = `${from}>${to}`;
      const seen = this.#transitions.get(key);
      if (seen === undefined) this.#transitions.set(key, { from, to, count: 1 });
      else seen.count++;
    };
    breaker.on("open", moved("open"));
    breaker.on("halfOpen", moved("halfOpen"));
    breaker.on("close", moved("closed"));

    return breaker;
  }

  /** Marks an error as one the breaker must not count against the dependency. */
  #notTheDependency(err: OutboundError): OutboundError {
    this.#benign.add(err);
    return err;
  }

  // ─── Core execution ──────────────────────────────────────────────────────

  async #executeRequest(
    opts: Dispatcher.RequestOptions,
    cacheKey?: string,
  ): Promise<Dispatcher.ResponseData> {
    if (this.#breaker.opened) {
      throw OutboundError.circuitOpen(this.baseUrl);
    }

    try {
      let response = await this.#breaker.fire(opts);

      // Buffer and cache for cacheable 2xx responses
      if (
        cacheKey !== undefined &&
        cacheKey !== "" &&
        this.#cacheConfig &&
        this.#isCacheable(opts, response.statusCode)
      ) {
        response = await this.#bufferAndCache(cacheKey, response);
      }

      return response;
    } catch (err) {
      if (err instanceof OutboundError) throw err;
      const original = (err as { cause?: unknown }).cause ?? err;
      if (original instanceof OutboundError) throw original;
      const { code, name } = err as { code?: unknown; name?: unknown };
      // A call refused while the half-open probe is out.
      if (code === "EOPENBREAKER") throw OutboundError.circuitOpen(this.baseUrl);
      if (name === "BottleneckError") throw OutboundError.rateLimited(this.baseUrl);
      // circuitBreaker.timeout, when someone turns it on.
      if (code === "ETIMEDOUT") throw OutboundError.timeout(this.baseUrl);
      throw OutboundError.network(err);
    }
  }

  // ─── Retry ───────────────────────────────────────────────────────────────

  async #executeWithRetry(opts: Dispatcher.RequestOptions): Promise<Dispatcher.ResponseData> {
    const attempts = this.#mayRepeat(opts) ? this.#maxRetries + 1 : 1;
    const own = opts.signal as AbortSignal | undefined;
    this.#budget?.request();

    for (let attempt = 0; ; attempt++) {
      // The caller's budget (getRemainingMs): spent → fail fast, not retried.
      const budget = this.config.getRemainingMs?.();
      if (budget !== undefined && budget <= 0) {
        throw this.#notTheDependency(OutboundError.deadlineExceeded(this.baseUrl));
      }
      const deadlineAt = budget === undefined ? undefined : Date.now() + budget;

      await this.#adaptiveLimiter?.acquire();
      const rttStart = Date.now();
      // What is left after waiting for a slot.
      const left = deadlineAt === undefined ? undefined : deadlineAt - rttStart;
      if (left !== undefined && left <= 0) {
        this.#adaptiveLimiter?.cancel();
        throw this.#notTheDependency(OutboundError.deadlineExceeded(this.baseUrl));
      }
      // The caller's budget ends the attempt before the target's own timeout would.
      const budgetEndsIt =
        left !== undefined &&
        (this.#attemptTimeoutMs === undefined || left <= this.#attemptTimeoutMs);

      let response: Dispatcher.ResponseData | undefined;
      let dispatchErr: unknown;

      try {
        const limited = this.#withLimits(opts, left);
        response = await endingWith(
          limited.signal as AbortSignal | undefined,
          this.#dispatcher.request(limited),
        );
      } catch (e) {
        dispatchErr = e;
      }

      const rtt = Date.now() - rttStart;
      let failure: OutboundError;

      if (response !== undefined) {
        const isRetryStatus = this.#retryStatusCodes.has(response.statusCode);
        this.#adaptiveLimiter?.release(rtt, isRetryStatus);

        if (!isRetryStatus) return this.#answer(response);

        const retryAfterMs = parseRetryAfter(response.headers["retry-after"]);
        await this.#drainBody(response);
        failure = OutboundError.retriesExhausted(this.baseUrl, response.statusCode, retryAfterMs);
      } else {
        this.#adaptiveLimiter?.release(rtt, true);

        if (dispatchErr instanceof OutboundError) throw dispatchErr;
        if (own?.aborted === true) {
          throw this.#notTheDependency(OutboundError.canceled(this.baseUrl, dispatchErr));
        }
        if (isTimeoutAbort(dispatchErr)) {
          // The dependency did not answer in the time it was given: a failure
          // either way, but the caller's budget leaves no room for a retry.
          if (budgetEndsIt) throw OutboundError.deadlineExceeded(this.baseUrl);
          failure = OutboundError.timeout(this.baseUrl);
        } else {
          failure = OutboundError.network(dispatchErr, this.baseUrl);
          const code = (dispatchErr as NodeJS.ErrnoException | null)?.code ?? "";
          if (!this.#retryErrorCodes.has(code)) throw failure;
        }
      }

      if (attempt + 1 >= attempts) throw failure;

      const retryAfterMs = failure.retryAfterMs ?? 0;
      if (retryAfterMs > this.#maxTimeout) throw failure;
      const delay = Math.max(this.#backoffDelay(attempt), retryAfterMs);
      const remaining = this.config.getRemainingMs?.();
      if (remaining !== undefined && remaining <= delay) throw failure;
      if (this.#budget?.tryRetry() === false) {
        this.#retryBudgetExhausted++;
        throw failure;
      }

      this.#retries++;
      await sleep(delay);
    }
  }

  /**
   * A response that is final: returned, or thrown — a 4xx (without
   * passthrough4xx), and any 5xx. A 5xx that reaches here is one the retry
   * policy does not repeat (501, 505, or one left out of `retry.statusCodes`):
   * returned as a response it would read as a success to a caller that
   * relies on the throw, and to the breaker.
   */
  async #answer(response: Dispatcher.ResponseData): Promise<Dispatcher.ResponseData> {
    const status = response.statusCode;
    if (status >= 500) {
      await this.#drainBody(response);
      throw OutboundError.serverError(status, this.baseUrl);
    }
    const isClientError = status >= 400;
    if (!isClientError || this.#passthrough4xx) return response;
    await this.#drainBody(response);
    throw this.#notTheDependency(OutboundError.clientError(status, this.baseUrl));
  }

  /** May the request be sent more than once: retries on, idempotent, body replayable. */
  #mayRepeat(opts: Dispatcher.RequestOptions): boolean {
    if (this.#maxRetries <= 0 || !isReplayable(opts.body)) return false;
    if (IDEMPOTENT_METHODS.has(opts.method.toUpperCase())) return true;
    const key = this.#normalizeHeaders(opts.headers)["idempotency-key"];
    return key !== undefined && key !== "";
  }

  /**
   * Full Jitter exponential back-off — delegated to the shared helper in
   * `./backoff.ts`. Kept as a method so the class reads the per-instance
   * spec fields without re-allocating a config object every attempt.
   */
  #backoffDelay(attempt: number): number {
    return computeJitteredDelay(
      {
        minTimeout: this.#minTimeout,
        maxTimeout: this.#maxTimeout,
        factor: this.#timeoutFactor,
      },
      attempt,
    );
  }

  #drainBody(response: Dispatcher.ResponseData): Promise<void> {
    return new Promise<void>((resolve) => {
      const body = response.body;
      if (body === null || body === undefined) {
        resolve();
        return;
      }
      body.on("end", resolve);
      body.on("error", resolve);
      body.resume();
    });
  }

  // ─── Cache helpers ───────────────────────────────────────────────────────

  /**
   * Returns a cache/coalesce key for the request, or undefined if the method
   * is not eligible (not GET/HEAD) or neither cache nor coalescing is active.
   */
  #idempotentKey(opts: Dispatcher.RequestOptions): string | undefined {
    if (!this.#cacheConfig && !this.#coalesce) return undefined;

    const method = (opts.method as string | undefined)?.toUpperCase() ?? "GET";
    const allowed = this.#cacheConfig
      ? (this.#cacheConfig.methods ?? ["GET", "HEAD"])
      : ["GET", "HEAD"];

    if (!allowed.includes(method)) return undefined;
    return `${method}:${this.baseUrl}${opts.path ?? ""}`;
  }

  #isCacheable(opts: Dispatcher.RequestOptions, statusCode: number): boolean {
    if (this.#cacheConfig === undefined) return false;
    const methods = this.#cacheConfig.methods ?? ["GET", "HEAD"];
    const method = (opts.method as string | undefined)?.toUpperCase() ?? "GET";
    return methods.includes(method) && statusCode >= 200 && statusCode < 300;
  }

  async #tryCacheHit(
    key: string,
    opts: Dispatcher.RequestOptions,
  ): Promise<Dispatcher.ResponseData | null> {
    const cache = this.#cacheConfig;
    if (cache === undefined) return null;
    let entry: CachedEntry | null;
    try {
      entry = await cache.adapter.get(key);
    } catch {
      // cache read errors are non-fatal
      return null;
    }
    if (!entry) return null;

    const ageSec = (Date.now() - entry.cachedAt) / 1000;
    const isFresh = ageSec <= entry.ttlSeconds;
    const staleTtl = cache.staleTtlSeconds ?? 0;
    const isStale = !isFresh && ageSec <= entry.ttlSeconds + staleTtl;

    if (isFresh) {
      return this.#responseFromEntry(entry);
    }

    if (isStale) {
      // Serve stale immediately; refresh in background
      this.#revalidate(opts, key);
      return this.#responseFromEntry(entry);
    }

    // Beyond stale window — evict and fall through to fresh fetch
    try {
      await cache.adapter.delete(key);
    } catch {}
    return null;
  }

  #responseFromEntry(entry: CachedEntry): Dispatcher.ResponseData {
    const buf = Buffer.from(entry.body, "base64");
    return {
      statusCode: entry.statusCode,
      statusText: "",
      headers: entry.headers,
      body: new CachedBodyReadable(buf) as unknown as Dispatcher.ResponseData["body"],
      trailers: {},
      opaque: null,
      context: {},
    };
  }

  async #bufferAndCache(
    key: string,
    response: Dispatcher.ResponseData,
  ): Promise<Dispatcher.ResponseData> {
    const cache = this.#cacheConfig;
    if (cache === undefined) return response;
    const chunks: Buffer[] = [];
    if (response.body !== null && response.body !== undefined) {
      try {
        for await (const chunk of response.body) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
        }
      } catch {
        // Body read error — skip caching, return empty body
      }
    }
    const buf = Buffer.concat(chunks);

    const entry: CachedEntry = {
      statusCode: response.statusCode,
      headers: response.headers as Record<string, string | string[]>,
      body: buf.toString("base64"),
      cachedAt: Date.now(),
      ttlSeconds: cache.ttlSeconds ?? 300,
    };

    try {
      await cache.adapter.set(key, entry);
    } catch {
      // Cache write errors are non-fatal
    }

    return {
      ...response,
      body: new CachedBodyReadable(buf) as unknown as Dispatcher.ResponseData["body"],
    };
  }

  /** Background stale-while-revalidate fetch — errors are silently discarded. */
  #revalidate(opts: Dispatcher.RequestOptions, key: string): void {
    void this.#executeRequest(opts, key).catch(() => {});
  }

  // ─── Header helpers ──────────────────────────────────────────────────────

  /**
   * One attempt, bounded: cancelled at the target's attempt timeout or when the
   * caller's budget runs out, whichever is first; the budget is told downstream.
   */
  #withLimits(
    options: Dispatcher.RequestOptions,
    leftMs: number | undefined,
  ): Dispatcher.RequestOptions {
    const limitMs = Math.min(leftMs ?? Infinity, this.#attemptTimeoutMs ?? Infinity);
    if (limitMs === Infinity) return options;
    const timeout = AbortSignal.timeout(Math.ceil(limitMs));
    const own = options.signal as AbortSignal | undefined;
    const bounded = {
      ...options,
      signal: own === undefined ? timeout : AbortSignal.any([own, timeout]),
    };
    if (leftMs === undefined) return bounded;
    const headers = this.#normalizeHeaders(options.headers);
    headers["x-request-timeout-ms"] = String(Math.max(1, Math.floor(leftMs)));
    return { ...bounded, headers };
  }

  #forwardRequestId(options: Dispatcher.RequestOptions): Dispatcher.RequestOptions {
    const requestId = this.config.getRequestId?.();
    if (requestId === undefined) return options;

    const headers = this.#normalizeHeaders(options.headers);
    headers["x-request-id"] = requestId;
    return { ...options, headers };
  }

  #applyShortLived(options: Dispatcher.RequestOptions): Dispatcher.RequestOptions {
    if (!this.#shortLived) return options;
    const headers = this.#normalizeHeaders(options.headers);
    headers["connection"] = "close";
    return { ...options, headers };
  }

  #applyUserAgent(options: Dispatcher.RequestOptions): Dispatcher.RequestOptions {
    if (this.#userAgent === undefined || this.#userAgent === "") return options;
    const headers = this.#normalizeHeaders(options.headers);
    headers["user-agent"] = this.#userAgent;
    return { ...options, headers };
  }

  #normalizeHeaders(existing: Dispatcher.RequestOptions["headers"]): Record<string, string> {
    if (!existing) return {};
    if (Array.isArray(existing)) {
      const out: Record<string, string> = {};
      for (let i = 0; i < existing.length - 1; i += 2) {
        out[String(existing[i]).toLowerCase()] = String(existing[i + 1]);
      }
      return out;
    }
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(existing as Record<string, string>)) {
      out[name.toLowerCase()] = value;
    }
    return out;
  }
}
