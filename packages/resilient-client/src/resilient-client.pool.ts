import { metrics } from "@opentelemetry/api";
import type { Counter, Histogram, Meter } from "@opentelemetry/api";

import type { CacheConfig } from "./resilient-client.cache.js";
import { OutboundError } from "./resilient-client.errors.js";
import { ResilientClient } from "./resilient-client.js";
import type {
  AdaptiveConcurrencyConfig,
  CircuitBreakerConfig,
  FallbackFn,
  Logger,
  RateLimitConfig,
  RetryConfig,
} from "./resilient-client.js";

const consoleLogger: Logger = {
  info: (obj: Record<string, unknown> | string, msg?: string) => {
    if (typeof obj === "string") console.info(obj);
    else console.info({ ...obj }, msg);
  },
  warn: (obj, msg) => {
    console.warn({ ...obj }, msg);
  },
  debug: (obj, msg) => {
    console.debug({ ...obj }, msg);
  },
  error: (obj, msg) => {
    console.error({ ...obj }, msg);
  },
};

// ─── Config ───────────────────────────────────────────────────────────────────

/**
 * Configuration for a single outbound target (resource group).
 *
 * The `selector` uses `{placeholder}` for variable URL segments:
 *   "://graph.facebook.com{pixel_id}/events"
 *   "://googleads.googleapis.com"
 *
 * Incoming request URLs are matched against selectors in declaration order.
 * First match wins.
 */
export interface OutboundTargetConfig {
  /** Logical identifier — used as metric label and for lookup. */
  name: string;
  /** URL pattern to match. Segments in `{braces}` are wildcards. */
  selector: string;
  /** Number of connections in the pool. Default: 10 */
  connections?: number;
  /** Request timeout ms. Default: 10_000 */
  timeout?: number;
  /** Short-lived mode: forces `Connection: close` on every request. */
  shortLived?: boolean;
  retry?: RetryConfig;
  rateLimit?: RateLimitConfig;
  circuitBreaker?: CircuitBreakerConfig;
  /** Override the User-Agent header for all requests to this target. */
  userAgent?: string;
  cache?: CacheConfig;
  /** Deduplicate concurrent identical GET/HEAD requests (SingleFlight). Default: false */
  coalesce?: boolean;
  fallback?: FallbackFn;
  adaptiveConcurrency?: AdaptiveConcurrencyConfig;
}

// ─── Config adapters ─────────────────────────────────────────────────────────

/**
 * Decouples target config from any specific runtime (NestJS, plain Node, tests).
 *
 * NestJS adapter example (user-land):
 *   class NestOutboundConfigAdapter implements ConfigAdapter {
 *     constructor(private readonly config: ConfigService) {}
 *     load() { return this.config.get<OutboundTargetConfig[]>('outbound_targets') ?? []; }
 *   }
 */
export interface ConfigAdapter {
  load(): OutboundTargetConfig[];
}

/** Wraps a plain array — primary adapter for tests and embedded use. */
export class StaticConfigAdapter implements ConfigAdapter {
  constructor(private readonly targets: OutboundTargetConfig[]) {}
  load(): OutboundTargetConfig[] {
    return this.targets;
  }
}

/** Wraps a zero-arg getter function — for NestJS factories and dynamic configs. */
export class FunctionConfigAdapter implements ConfigAdapter {
  constructor(private readonly getter: () => OutboundTargetConfig[]) {}
  load(): OutboundTargetConfig[] {
    return this.getter();
  }
}

// ─── ResilientPool ────────────────────────────────────────────────────────────

interface PoolMetrics {
  requestDuration: Histogram;
  requestsTotal: Counter;
}

/** Latency buckets (seconds) shared with the HTTP server, db and Kafka histograms. */
const LATENCY_BUCKETS_SECONDS = [
  0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

const STANDARD_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "CONNECT",
  "OPTIONS",
  "TRACE",
]);

/** The outcome label of a call: the status class of the last response, else the error kind. */
export function outcomeOf(status: number | undefined, err?: OutboundError): string {
  if (status !== undefined && status >= 100 && status < 600) return `${Math.floor(status / 100)}xx`;
  return err?.errorType ?? "unknown";
}

/** Breaker state as a gauge value — the scale golang-basics uses. */
const BREAKER_STATE = { closed: 0, open: 1, halfOpen: 2 } as const;

/**
 * Multi-target outbound HTTP pool.
 *
 * Manages one `ResilientClient` per configured outbound target. Incoming requests
 * are routed by matching the full URL against each target's `selector` pattern.
 *
 * Metrics (the contract shared with golang-basics' resilient-http-client;
 * `target` is the configured name, never the URL):
 *   http_client_requests_total{target,method,outcome}   outcome: 2xx…5xx, or the error kind
 *   http_client_request_duration_seconds{target,method}
 *   http_client_retries_total{target}                    attempts after the first
 *   http_client_circuit_breaker_state{target}            0 closed, 1 open, 2 half-open
 *
 * Usage:
 *   const pool = ResilientPool.fromAdapter(new StaticConfigAdapter(targets));
 *   const response = await pool.send("https://graph.facebook.com/123/events", {
 *     method: "POST", path: "/123/events", body: payload,
 *   });
 */
export class ResilientPool {
  readonly #clients: Map<string, ResilientClient> = new Map();
  readonly #selectors: ReadonlyArray<{ name: string; selector: string }>;
  readonly #m: PoolMetrics;
  readonly #logger: Logger;
  #inFlight = 0;
  #shuttingDown = false;

  private constructor(
    targets: OutboundTargetConfig[],
    private readonly meter: Meter,
    logger?: Logger,
  ) {
    this.#logger = logger ?? consoleLogger;
    this.#selectors = targets.map((t) => ({ name: t.name, selector: t.selector }));

    for (const target of targets) {
      const { name, selector, connections, timeout: _timeout, ...options } = target;
      this.#clients.set(
        name,
        new ResilientClient(extractBaseUrl(selector), {
          ...options,
          connections: connections ?? 10,
        }),
      );
    }

    this.#m = this.#initMetrics();
  }

  static fromAdapter(adapter: ConfigAdapter, meter?: Meter, logger?: Logger): ResilientPool {
    const targets = adapter.load();
    return new ResilientPool(targets, meter ?? metrics.getMeter("http.client"), logger);
  }

  /**
   * Sends an HTTP request to the best-matching target.
   *
   * @param url  Full URL — used for target resolution.
   * @param opts Dispatcher options; `path` must match the URL path.
   *
   * @throws OutboundError (kind='transient') for CB open, rate limits, network errors.
   * @throws OutboundError (kind='fatal') for 4xx, no matching target, shutting down.
   */
  async send(
    url: string,
    opts: Omit<import("undici").Dispatcher.RequestOptions, "origin">,
  ): Promise<import("undici").Dispatcher.ResponseData> {
    if (this.#shuttingDown) throw OutboundError.shuttingDown();

    const resolution = this.#resolveTarget(url);
    if (!resolution) throw OutboundError.noMatchingTarget(url);

    const { name, client } = resolution;
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;

    this.#inFlight++;

    const start = Date.now();
    const method = (opts.method as string | undefined) ?? "GET";

    this.#logger.info(
      {
        "http.request.method": method,
        "url.full": url,
        outbound_target: name,
      },
      "Outbound request started",
    );

    try {
      const response = await client.request({ ...opts, path });

      const durationMs = Date.now() - start;
      this.#recordSuccess(name, method, response.statusCode, durationMs);

      this.#logger.info(
        {
          "http.request.method": method,
          "url.full": url,
          outbound_target: name,
          "http.response.status_code": response.statusCode,
          "http.response.time_ms": durationMs,
        },
        "Outbound request completed",
      );

      return response;
    } catch (err) {
      const durationMs = Date.now() - start;
      const outErr = err instanceof OutboundError ? err : OutboundError.network(err, name);
      this.#recordFailure(name, method, outErr, durationMs);

      this.#logger.warn(
        {
          "http.request.method": method,
          "url.full": url,
          outbound_target: name,
          "http.response.time_ms": durationMs,
          "error.type": outErr.errorType,
          "error.message": outErr.message,
        },
        "Outbound request failed",
      );

      throw outErr;
    } finally {
      this.#inFlight--;
    }
  }

  /**
   * Returns circuit breaker states for all targets (useful for health endpoints).
   */
  circuitBreakerStates(): Record<string, "closed" | "open" | "halfOpen"> {
    return Object.fromEntries(
      [...this.#clients.entries()].map(([name, client]) => [name, client.breakerState]),
    );
  }

  /**
   * Gracefully shuts down: rejects new requests immediately, waits up to
   * `timeoutMs` for all in-flight requests to drain, then closes all pools.
   */
  async shutdown(timeoutMs = 30_000): Promise<void> {
    this.#shuttingDown = true;
    this.#logger.info(
      { "outbound.in_flight": this.#inFlight },
      "ResilientPool: shutdown initiated",
    );

    await waitFor(() => this.#inFlight === 0, timeoutMs);

    if (this.#inFlight > 0) {
      this.#logger.warn(
        { "outbound.in_flight": this.#inFlight },
        "ResilientPool: shutdown timed out, closing with in-flight requests",
      );
    }

    await Promise.all([...this.#clients.values()].map((c) => c.close()));
    this.#logger.info({ "outbound.in_flight": 0 }, "ResilientPool: shutdown complete");
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  #resolveTarget(url: string): { name: string; client: ResilientClient } | undefined {
    for (const { name, selector } of this.#selectors) {
      if (matchesSelector(url, selector)) {
        const client = this.#clients.get(name);
        if (client) return { name, client };
      }
    }
    return undefined;
  }

  #initMetrics(): PoolMetrics {
    const requestDuration = this.meter.createHistogram("http_client_request_duration_seconds", {
      description:
        "Outbound HTTP call latency in seconds (retries included), by target and method.",
      unit: "s",
      advice: { explicitBucketBoundaries: LATENCY_BUCKETS_SECONDS },
    });

    const requestsTotal = this.meter.createCounter("http_client_requests_total", {
      description:
        "Outbound HTTP calls by target, method and outcome (status class or error kind).",
    });

    const retries = this.meter.createObservableCounter("http_client_retries_total", {
      description: "Retries sent (attempts after the first), by target.",
    });
    retries.addCallback((result) => {
      for (const [name, client] of this.#clients) result.observe(client.retries, { target: name });
    });

    const cbState = this.meter.createObservableGauge("http_client_circuit_breaker_state", {
      description: "Circuit breaker state per target: 0 closed, 1 open, 2 half-open.",
    });
    cbState.addCallback((result) => {
      for (const [name, client] of this.#clients) {
        result.observe(BREAKER_STATE[client.breakerState], { target: name });
      }
    });

    return { requestDuration, requestsTotal };
  }

  #record(target: string, rawMethod: string, outcome: string, durationMs: number): void {
    const method = STANDARD_METHODS.has(rawMethod) ? rawMethod : "_OTHER";
    this.#m.requestsTotal.add(1, { target, method, outcome });
    this.#m.requestDuration.record(durationMs / 1000, { target, method });
  }

  #recordSuccess(target: string, method: string, status: number, durationMs: number): void {
    this.#record(target, method, outcomeOf(status), durationMs);
  }

  #recordFailure(target: string, method: string, err: OutboundError, durationMs: number): void {
    this.#record(target, method, outcomeOf(err.statusCode, err), durationMs);
  }
}

// ─── Helpers (exported for testing) ──────────────────────────────────────────

/**
 * Matches a full URL against a selector pattern.
 * `{placeholder}` wildcards in the selector match any characters.
 * Example: "://graph.facebook.com{pixel_id}/events" matches
 *          "https://graph.facebook.com/123456/events"
 */
export function matchesSelector(url: string, selector: string): boolean {
  const parts = selector.split(/\{[^}]+\}/u);
  let pos = 0;
  for (const part of parts) {
    if (!part) continue;
    const idx = url.indexOf(part, pos);
    if (idx === -1) return false;
    pos = idx + part.length;
  }
  return true;
}

/**
 * Extracts the origin (scheme + host) from a URL selector pattern.
 * "://graph.facebook.com{pixel_id}/events" → "https://graph.facebook.com"
 * "https://googleads.googleapis.com"       → "https://googleads.googleapis.com"
 */
export function extractBaseUrl(selector: string): string {
  const normalized = selector.startsWith("://") ? `https${selector}` : selector;
  const match = normalized.match(/^(https?:\/\/[^/{?#]+)/u);
  if (!match) throw new Error(`Cannot derive base URL from selector: "${selector}"`);
  return match[1] ?? "";
}

// ─── Internal ─────────────────────────────────────────────────────────────────

/** Polls the predicate every 50 ms until it's true or the deadline passes. */
function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if (predicate()) {
      resolve();
      return;
    }

    const deadline = Date.now() + timeoutMs;
    const interval = setInterval(() => {
      if (predicate() || Date.now() >= deadline) {
        clearInterval(interval);
        resolve();
      }
    }, 50);
  });
}
