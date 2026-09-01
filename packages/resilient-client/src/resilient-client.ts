import Bottleneck from "bottleneck";
import CircuitBreaker from "opossum";
import { Client, Pool } from "undici";
import type { Dispatcher } from "undici";

import { computeJitteredDelay, sleep } from "./backoff.js";
import { CachedBodyReadable } from "./resilient-client.cache.js";
import type { CacheConfig, CachedEntry } from "./resilient-client.cache.js";
import { OutboundError } from "./resilient-client.errors.js";

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
  /** HTTP status codes that trigger a retry. Default: [429, 502, 503, 504] */
  statusCodes?: number[];
  /** Node.js error codes that trigger a retry. */
  errorCodes?: string[];
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
  /** Action timeout ms; false to disable. Default: 10_000 */
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
  retry?: RetryConfig;
  rateLimit?: RateLimitConfig;
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

    this.#retryStatusCodes = new Set(config.retry?.statusCodes ?? [429, 502, 503, 504]);
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

  /** Current circuit breaker state. */
  get breakerState(): "closed" | "open" | "halfOpen" {
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
      // TLS options are only consulted by undici when the base URL scheme is
      // `https://`. Passing them on a plaintext URL is harmless (undici
      // ignores `connect` on http:// connections) but keep the conditional
      // so a debugger doesn't see a stray connect callback in dev.
      ...(tls && this.baseUrl.startsWith("https://") ? { connect: tls } : {}),
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
      timeout: cb.timeout ?? 10_000,
      errorThresholdPercentage: cb.errorThresholdPercentage ?? 50,
      resetTimeout: cb.resetTimeout ?? 30_000,
      volumeThreshold: cb.volumeThreshold ?? 5,
    });

    breaker.on("failure", (err) => {
      if (err?.name === "BottleneckError") {
        OutboundError.rateLimited(this.baseUrl);
      }
    });

    return breaker;
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
      throw OutboundError.network(err);
    }
  }

  // ─── Retry ───────────────────────────────────────────────────────────────

  async #executeWithRetry(opts: Dispatcher.RequestOptions): Promise<Dispatcher.ResponseData> {
    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      await this.#adaptiveLimiter?.acquire();
      const rttStart = Date.now();

      let response: Dispatcher.ResponseData | undefined;
      let dispatchErr: unknown;

      try {
        response = await this.#dispatcher.request(opts);
      } catch (e) {
        dispatchErr = e;
      }

      const rtt = Date.now() - rttStart;

      if (response !== undefined) {
        const isRetryStatus = this.#retryStatusCodes.has(response.statusCode);
        this.#adaptiveLimiter?.release(rtt, isRetryStatus);

        if (isRetryStatus) {
          await this.#drainBody(response);
          if (attempt < this.#maxRetries) {
            await this.#backoff(attempt);
            continue;
          }
          throw OutboundError.retriesExhausted(this.baseUrl, response.statusCode);
        }

        if (response.statusCode >= 400 && response.statusCode < 500) {
          if (this.#passthrough4xx) return response;
          await this.#drainBody(response);
          throw OutboundError.clientError(response.statusCode, this.baseUrl);
        }

        return response;
      }

      // Dispatch threw an error
      this.#adaptiveLimiter?.release(rtt, true);

      if (dispatchErr instanceof OutboundError) throw dispatchErr;

      const code = (dispatchErr as NodeJS.ErrnoException).code ?? "";
      if (this.#retryErrorCodes.has(code) && attempt < this.#maxRetries) {
        await this.#backoff(attempt);
        continue;
      }

      throw OutboundError.network(dispatchErr);
    }

    throw new Error("Unreachable");
  }

  /**
   * Full Jitter exponential back-off — delegated to the shared helper in
   * `./backoff.ts`. Kept as a method so the class reads the per-instance
   * spec fields without re-allocating a config object every attempt.
   */
  #backoff(attempt: number): Promise<void> {
    const delay = computeJitteredDelay(
      {
        minTimeout: this.#minTimeout,
        maxTimeout: this.#maxTimeout,
        factor: this.#timeoutFactor,
      },
      attempt,
    );
    return sleep(delay);
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
    const methods = this.#cacheConfig!.methods ?? ["GET", "HEAD"];
    const method = (opts.method as string | undefined)?.toUpperCase() ?? "GET";
    return methods.includes(method) && statusCode >= 200 && statusCode < 300;
  }

  async #tryCacheHit(
    key: string,
    opts: Dispatcher.RequestOptions,
  ): Promise<Dispatcher.ResponseData | null> {
    let entry: CachedEntry | null;
    try {
      entry = await this.#cacheConfig!.adapter.get(key);
    } catch {
      // cache read errors are non-fatal
      return null;
    }
    if (!entry) return null;

    const ageSec = (Date.now() - entry.cachedAt) / 1000;
    const isFresh = ageSec <= entry.ttlSeconds;
    const staleTtl = this.#cacheConfig!.staleTtlSeconds ?? 0;
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
      await this.#cacheConfig!.adapter.delete(key);
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
      ttlSeconds: this.#cacheConfig!.ttlSeconds ?? 300,
    };

    try {
      await this.#cacheConfig!.adapter.set(key, entry);
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
    return { ...(existing as Record<string, string>) };
  }
}
