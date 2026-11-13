import { metrics } from "@opentelemetry/api";
import type { Counter, Meter } from "@opentelemetry/api";

/**
 * Marks a key as "recently invalidated": a lookup reports it as a miss and a
 * cache fill (SET NX) cannot overwrite it. Not valid JSON, so no cached value
 * can collide with it. The same marker as golang-basics' libs/valkey.
 */
export const TOMBSTONE = "\u0000valkey:tombstone";

/** The two commands the helper needs — an iovalkey client, or a stand-in in a test. */
export interface AsideClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, px: "PX", ms: number): Promise<unknown>;
  set(key: string, value: string, px: "PX", ms: number, nx: "NX"): Promise<unknown>;
}

export interface AsideLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface CacheAsideOptions {
  logger?: AsideLogger;
  /** Meter for cache_lookups_total. Default: the global one. */
  meter?: Meter;
  /** Random source for the TTL jitter, in [0, 1). Default: Math.random. */
  random?: () => number;
}

/**
 * `ttlMs` spread uniformly over ±10 %, so keys filled together (a warm-up, a
 * burst of misses after a deploy) do not all expire together and stampede the
 * source of truth at once.
 */
export function jitter(ttlMs: number, random: () => number = Math.random): number {
  const spread = Math.floor(ttlMs / 10);
  if (spread <= 0) return ttlMs;
  return ttlMs - spread + Math.floor(random() * (2 * spread + 1));
}

/**
 * The cache-aside (lazy-loading) pattern over a Valkey client — the same rules
 * as golang-basics' valkey.Aside:
 *
 *   const cache = new CacheAside(valkey, { logger });
 *   const { value, hit } = await cache.get(`task:${id}`, 60_000, () => repo.find(id));
 *   // after the write to the source of truth has committed:
 *   await afterCommit(() => cache.tombstone(`task:${id}`, 5_000));
 *
 * - Concurrent misses on one key share a single load (singleflight): a hot key
 *   expiring does not turn into N identical queries. Waiters receive the same
 *   value — treat it as read-only.
 * - The fill is a SET NX with ttl ±10 %: it never overwrites a tombstone, so a
 *   load that raced an invalidation cannot resurrect stale data.
 * - A corrupt entry, a failed lookup or a failed fill is a miss / a warning:
 *   the source of truth always wins, so caching never turns a readable value
 *   into an error. The loader's own error is thrown as it is.
 *
 * Values are JSON; a loader that returns undefined is not cached.
 */
export class CacheAside {
  readonly #client: AsideClient;
  readonly #logger: AsideLogger | undefined;
  readonly #random: () => number;
  readonly #lookups: Counter;
  readonly #flights = new Map<string, Promise<unknown>>();

  constructor(client: AsideClient, options: CacheAsideOptions = {}) {
    this.#client = client;
    this.#logger = options.logger;
    this.#random = options.random ?? Math.random;
    this.#lookups = (options.meter ?? metrics.getMeter("cache")).createCounter(
      "cache_lookups_total",
      {
        description:
          "Cache lookups by outcome: hit, miss (absent or tombstoned), or error (lookup itself failed).",
      },
    );
  }

  /** The value at `key`, loading and caching it for `ttlMs` on a miss. `hit` says which. */
  async get<T>(
    key: string,
    ttlMs: number,
    load: () => Promise<T>,
  ): Promise<{ value: T; hit: boolean }> {
    const cached = await this.#lookup(key);
    if (cached !== undefined) return { value: cached.value as T, hit: true };

    let flight = this.#flights.get(key) as Promise<T> | undefined;
    if (flight === undefined) {
      flight = this.#loadAndFill(key, ttlMs, load).finally(() => {
        this.#flights.delete(key);
      });
      this.#flights.set(key, flight);
    }
    return { value: await flight, hit: false };
  }

  /**
   * Invalidates `key` for `ttlMs`: the current value (if any) is replaced by a
   * marker that reads as a miss and that a fill cannot overwrite until it
   * expires. Call it after the write to the source of truth has committed.
   *
   * Why not a plain DEL: a reader that loaded the old row just before the
   * commit writes it back just after the DEL, and the stale value lives for a
   * full TTL — worse, a deleted row is resurrected. With a tombstone that
   * write-back is refused. The window left is a reader that sits between its
   * load and its write-back for longer than `ttlMs`, so it should be a few
   * times the slowest load (seconds, not milliseconds).
   */
  async tombstone(key: string, ttlMs: number): Promise<void> {
    if (!(ttlMs > 0))
      throw new Error(`cache: tombstone ${JSON.stringify(key)}: ttl must be positive`);
    await this.#client.set(key, TOMBSTONE, "PX", Math.ceil(ttlMs));
  }

  async #lookup(key: string): Promise<{ value: unknown } | undefined> {
    let raw: string | null;
    try {
      raw = await this.#client.get(key);
    } catch (err) {
      this.#lookups.add(1, { result: "error" });
      this.#warn(key, "Cache lookup failed, loading from source", err);
      return undefined;
    }
    if (raw === null || raw === TOMBSTONE) {
      this.#lookups.add(1, { result: "miss" });
      return undefined;
    }
    this.#lookups.add(1, { result: "hit" });
    try {
      return { value: JSON.parse(raw) as unknown };
    } catch {
      this.#warn(key, "Discarding corrupt cache entry");
      return undefined;
    }
  }

  async #loadAndFill<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const value = await load();
    let encoded: string | undefined;
    try {
      encoded = JSON.stringify(value);
    } catch (err) {
      this.#warn(key, "Cannot encode value for the cache", err);
    }
    if (encoded !== undefined) {
      try {
        const ttl = Math.max(1, Math.ceil(jitter(ttlMs, this.#random)));
        await this.#client.set(key, encoded, "PX", ttl, "NX");
      } catch (err) {
        this.#warn(key, "Cache write failed", err);
      }
    }
    return value;
  }

  #warn(key: string, msg: string, err?: unknown): void {
    this.#logger?.warn(
      {
        "cache.key": key,
        ...(err === undefined
          ? {}
          : { "error.message": err instanceof Error ? err.message : "unknown error" }),
      },
      msg,
    );
  }
}
