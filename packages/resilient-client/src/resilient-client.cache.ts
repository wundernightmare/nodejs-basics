import { Readable } from "node:stream";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CachedEntry {
  statusCode: number;
  headers: Record<string, string | string[]>;
  /** Base64-encoded response body. */
  body: string;
  /** Unix epoch ms when this entry was stored. */
  cachedAt: number;
  /** Fresh TTL in seconds. */
  ttlSeconds: number;
}

export interface CacheAdapter {
  get(key: string): Promise<CachedEntry | null>;
  set(key: string, entry: CachedEntry): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface CacheConfig {
  adapter: CacheAdapter;
  /** Seconds to treat a cached response as fresh. Default: 300 */
  ttlSeconds?: number;
  /**
   * Extra seconds after TTL expiry to serve a stale response while revalidating
   * in the background (stale-while-revalidate). Default: 0 (disabled).
   */
  staleTtlSeconds?: number;
  /** HTTP methods eligible for caching. Default: ["GET", "HEAD"] */
  methods?: string[];
}

/** Minimal Valkey/Redis surface required by ValkeyCache. */
export interface ValkeyLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<string | null>;
  del(key: string): Promise<number>;
}

// ─── Adapters ─────────────────────────────────────────────────────────────────

/** In-process LRU-less cache backed by a plain Map. Safe for single-process Node. */
export class MemoryCache implements CacheAdapter {
  readonly #store = new Map<string, CachedEntry>();

  get(key: string): Promise<CachedEntry | null> {
    return Promise.resolve(this.#store.get(key) ?? null);
  }

  set(key: string, entry: CachedEntry): Promise<void> {
    this.#store.set(key, entry);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.#store.delete(key);
    return Promise.resolve();
  }

  /**
   * Evict entries whose freshness + stale window has elapsed.
   * Call periodically for memory management (not required for correctness).
   */
  evictExpired(staleTtlSeconds = 0): void {
    const now = Date.now();
    for (const [key, entry] of this.#store) {
      if ((now - entry.cachedAt) / 1000 > entry.ttlSeconds + staleTtlSeconds) {
        this.#store.delete(key);
      }
    }
  }

  get size(): number {
    return this.#store.size;
  }

  clear(): void {
    this.#store.clear();
  }
}

/**
 * Cache adapter backed by a Valkey/Redis store.
 * Entries are serialised as JSON with EX = ttlSeconds + staleTtlSeconds so they
 * remain available for stale-while-revalidate.  Pass the same `staleTtlSeconds`
 * value here as in your `CacheConfig`.
 */
export class ValkeyCache implements CacheAdapter {
  constructor(
    private readonly client: ValkeyLike,
    private readonly prefix = "rc:",
    private readonly staleTtlSeconds = 0,
  ) {}

  async get(key: string): Promise<CachedEntry | null> {
    const raw = await this.client.get(this.prefix + key);
    if (raw === null || raw === "") return null;
    try {
      return JSON.parse(raw) as CachedEntry;
    } catch {
      return null;
    }
  }

  async set(key: string, entry: CachedEntry): Promise<void> {
    const totalTtl = entry.ttlSeconds + this.staleTtlSeconds;
    await this.client.set(this.prefix + key, JSON.stringify(entry), "EX", totalTtl);
  }

  async delete(key: string): Promise<void> {
    await this.client.del(this.prefix + key);
  }
}

// ─── Internal: cached body stream ─────────────────────────────────────────────

/**
 * A Readable stream backed by an in-memory Buffer that also exposes the
 * BodyReadable convenience API (.text(), .json(), .arrayBuffer(), .bytes()).
 * Returned in place of the original streaming body when caching is active.
 */
export class CachedBodyReadable extends Readable {
  constructor(private readonly data: Buffer) {
    super();
  }

  override _read(): void {
    this.push(this.data);
    this.push(null);
  }

  text(): Promise<string> {
    return Promise.resolve(this.data.toString("utf-8"));
  }

  json(): Promise<unknown> {
    return Promise.resolve(JSON.parse(this.data.toString("utf-8")) as unknown);
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(
      this.data.buffer.slice(
        this.data.byteOffset,
        this.data.byteOffset + this.data.byteLength,
      ) as ArrayBuffer,
    );
  }

  bytes(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(this.data));
  }

  blob(): Promise<Blob> {
    return Promise.resolve(new Blob([new Uint8Array(this.data)]));
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  dump(_opts?: { limit?: number }): Promise<void> {
    // Data is already buffered — nothing to drain.
    return Promise.resolve();
  }
}
