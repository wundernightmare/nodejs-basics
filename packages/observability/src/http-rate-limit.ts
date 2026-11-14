/**
 * Inbound rate limit for the API listener — the server protecting itself, not
 * a quota system: a token bucket for everything (`HTTP_RATE_LIMIT`) and one
 * per client address (`HTTP_RATE_LIMIT_PER_CLIENT`). Off unless a rate is set;
 * then a request over the limit is answered 429 application/problem+json with
 * `Retry-After` (whole seconds, rounded up) and counted in
 * `http_rate_limited_total{scope}` (`global` | `client`).
 *
 * The contract is golang-basics' (libs/httpx/ratelimit.go):
 *   - buckets start full; `burst` 0 means max(1, ceil(rate));
 *   - the client's bucket is asked first: a client refused there does not
 *     take a token from the global bucket (it cannot starve the others);
 *   - the client table is bounded (`HTTP_RATE_CLIENTS_MAX`): when full, the
 *     buckets that have refilled completely are dropped; if that frees
 *     nothing, a NEW client is refused (scope `client`, Retry-After 1) —
 *     known clients keep their state, memory stays bounded under a flood of
 *     addresses;
 *   - the admin listener (probes, /metrics) is a different server and is
 *     never limited. Nothing on the API listener is exempt.
 *
 * A client is `request.ip`: the peer address, or — behind a proxy listed in
 * `HTTP_TRUSTED_PROXIES` (Fastify `trustProxy`) — the first address of
 * X-Forwarded-For that is not a trusted proxy. Without that setting every
 * request through a load balancer is one client.
 *
 * Register it after registerHttpInstrumentation: a refused request is still
 * counted in http_requests_total{status="429"} and logged.
 */
import { metrics } from "@opentelemetry/api";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { getRequestId } from "@base/logger";

export interface RateLimitConfig {
  /** Requests per second for the whole listener; 0 = no global limit. */
  rate: number;
  /** Depth of the global bucket; 0 = max(1, ceil(rate)). */
  burst: number;
  /** Requests per second per client address; 0 = no per-client limit. */
  perClientRate: number;
  /** Depth of a client's bucket; 0 = max(1, ceil(perClientRate)). */
  perClientBurst: number;
  /** Most client buckets kept. */
  maxClients: number;
}

export const DEFAULT_RATE_CLIENTS_MAX = 10_000;

/** Milliseconds since some fixed point; injectable for tests. */
export type Clock = () => number;

/** A token bucket that starts full. Not shared between processes. */
export class TokenBucket {
  readonly burst: number;
  #tokens: number;
  #at: number;

  constructor(
    private readonly rate: number,
    burst: number,
    now: number,
  ) {
    this.burst = burst > 0 ? burst : Math.max(1, Math.ceil(rate));
    this.#tokens = this.burst;
    this.#at = now;
  }

  /** The tokens available at `now`. */
  tokensAt(now: number): number {
    const elapsed = Math.max(0, now - this.#at) / 1000;
    return Math.min(this.burst, this.#tokens + elapsed * this.rate);
  }

  /** Takes one token: 0 when taken, else the milliseconds until one is there (nothing is spent). */
  take(now: number): number {
    const tokens = this.tokensAt(now);
    this.#at = Math.max(this.#at, now);
    if (tokens >= 1) {
      this.#tokens = tokens - 1;
      return 0;
    }
    this.#tokens = tokens;
    return ((1 - tokens) / this.rate) * 1000;
  }
}

export type RateDecision =
  | { allowed: true }
  | { allowed: false; scope: "global" | "client"; retryAfterSeconds: number };

/** The decision, apart from HTTP: per-client first, then global. */
export class RateLimiter {
  readonly #global: TokenBucket | undefined;
  readonly #clients = new Map<string, TokenBucket>();
  readonly #config: RateLimitConfig;
  readonly #now: Clock;

  constructor(config: RateLimitConfig, now: Clock = () => performance.now()) {
    this.#config = config;
    this.#now = now;
    this.#global = config.rate > 0 ? new TokenBucket(config.rate, config.burst, now()) : undefined;
  }

  /** Client buckets held right now. */
  get clients(): number {
    return this.#clients.size;
  }

  decide(client: string): RateDecision {
    const now = this.#now();
    if (this.#config.perClientRate > 0) {
      const bucket = this.#client(client, now);
      // The table is full of clients mid-burst: shed the newcomer.
      if (bucket === undefined) return { allowed: false, scope: "client", retryAfterSeconds: 1 };
      const wait = bucket.take(now);
      if (wait > 0) return refused("client", wait);
    }
    const wait = this.#global?.take(now) ?? 0;
    return wait > 0 ? refused("global", wait) : { allowed: true };
  }

  #client(client: string, now: number): TokenBucket | undefined {
    const known = this.#clients.get(client);
    if (known !== undefined) return known;
    if (this.#clients.size >= this.#config.maxClients) {
      for (const [key, bucket] of this.#clients) {
        if (bucket.tokensAt(now) >= bucket.burst) this.#clients.delete(key);
      }
      if (this.#clients.size >= this.#config.maxClients) return undefined;
    }
    const bucket = new TokenBucket(this.#config.perClientRate, this.#config.perClientBurst, now);
    this.#clients.set(client, bucket);
    return bucket;
  }
}

function refused(scope: "global" | "client", waitMs: number): RateDecision {
  return { allowed: false, scope, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
}

/**
 * Installs the limit as an onRequest hook. Does nothing — no hook, no metric
 * series — when neither rate is set. Returns the limiter (tests, diagnostics).
 */
export function registerRateLimit(
  fastify: FastifyInstance,
  config: RateLimitConfig,
  now?: Clock,
): RateLimiter | undefined {
  for (const [name, value] of Object.entries(config)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`rate limit: ${name} must be a non-negative number, got ${String(value)}`);
    }
  }
  if (config.rate <= 0 && config.perClientRate <= 0) return undefined;

  const limiter = new RateLimiter(
    { ...config, maxClients: config.maxClients > 0 ? config.maxClients : DEFAULT_RATE_CLIENTS_MAX },
    now,
  );
  const limited = metrics.getMeter("http.server").createCounter("http_rate_limited_total", {
    description: "Requests answered 429 by the server's own rate limit, by scope.",
  });

  fastify.addHook("onRequest", (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    const decision = limiter.decide(request.ip);
    if (decision.allowed) {
      done();
      return;
    }
    limited.add(1, { scope: decision.scope });
    const url = request.url;
    const qIdx = url.indexOf("?");
    const requestId = getRequestId() ?? request.id;
    void reply
      .code(429)
      .header("Retry-After", String(decision.retryAfterSeconds))
      .type("application/problem+json")
      .send({
        type: "about:blank",
        title: "Too Many Requests",
        status: 429,
        detail: "rate limit exceeded; retry after the time in Retry-After",
        instance: qIdx === -1 ? url : url.slice(0, qIdx),
        request_id: requestId,
      });
  });
  return limiter;
}

/**
 * HTTP_TRUSTED_PROXIES → Fastify's `trustProxy`: a comma-separated list of
 * addresses or CIDRs. Empty = trust nobody (`request.ip` is the peer).
 */
export function parseTrustedProxies(raw: string | undefined): string[] | false {
  const list = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return list.length === 0 ? false : list;
}
