import { beforeEach, describe, expect, it, vi } from "vitest";

import { CachedBodyReadable, MemoryCache, ValkeyCache } from "./resilient-client.cache.js";
import type { CachedEntry, ValkeyLike } from "./resilient-client.cache.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<CachedEntry> = {}): CachedEntry {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ ok: true })).toString("base64"),
    cachedAt: Date.now(),
    ttlSeconds: 60,
    ...overrides,
  };
}

// ─── MemoryCache ─────────────────────────────────────────────────────────────

describe("MemoryCache", () => {
  let cache: MemoryCache;

  beforeEach(() => {
    cache = new MemoryCache();
  });

  it("returns null for missing key", async () => {
    expect(await cache.get("missing")).toBeNull();
  });

  it("stores and retrieves an entry", async () => {
    const entry = makeEntry();
    await cache.set("k1", entry);
    expect(await cache.get("k1")).toEqual(entry);
  });

  it("deletes an entry", async () => {
    const entry = makeEntry();
    await cache.set("k1", entry);
    await cache.delete("k1");
    expect(await cache.get("k1")).toBeNull();
  });

  it("overwrite is idempotent — returns latest value", async () => {
    const first = makeEntry({ statusCode: 200 });
    const second = makeEntry({ statusCode: 304 });
    await cache.set("k1", first);
    await cache.set("k1", second);
    expect((await cache.get("k1"))?.statusCode).toBe(304);
  });

  it("reports correct size", async () => {
    expect(cache.size).toBe(0);
    await cache.set("a", makeEntry());
    await cache.set("b", makeEntry());
    expect(cache.size).toBe(2);
    await cache.delete("a");
    expect(cache.size).toBe(1);
  });

  it("clear removes all entries", async () => {
    await cache.set("a", makeEntry());
    await cache.set("b", makeEntry());
    cache.clear();
    expect(cache.size).toBe(0);
  });

  describe("evictExpired", () => {
    it("removes entries past ttl with no stale window", async () => {
      const expired = makeEntry({ cachedAt: Date.now() - 120_000, ttlSeconds: 60 });
      const fresh = makeEntry({ cachedAt: Date.now(), ttlSeconds: 60 });
      await cache.set("expired", expired);
      await cache.set("fresh", fresh);

      cache.evictExpired(0);

      expect(await cache.get("expired")).toBeNull();
      expect(await cache.get("fresh")).not.toBeNull();
    });

    it("respects extra stale window", async () => {
      // entry expired 90s ago, but stale window is 120s → still within stale window
      const entry = makeEntry({ cachedAt: Date.now() - 90_000, ttlSeconds: 60 });
      await cache.set("stale", entry);
      cache.evictExpired(120);
      expect(await cache.get("stale")).not.toBeNull();
    });

    it("evicts entries past stale window", async () => {
      const entry = makeEntry({ cachedAt: Date.now() - 200_000, ttlSeconds: 60 });
      await cache.set("old", entry);
      cache.evictExpired(120);
      expect(await cache.get("old")).toBeNull();
    });
  });
});

// ─── ValkeyCache ─────────────────────────────────────────────────────────────

describe("ValkeyCache", () => {
  let valkey: ValkeyLike;
  let cache: ValkeyCache;

  beforeEach(() => {
    const store = new Map<string, string>();
    valkey = {
      get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
      set: vi.fn((key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve("OK");
      }),
      del: vi.fn((key: string) => {
        const had = store.has(key);
        store.delete(key);
        return Promise.resolve(had ? 1 : 0);
      }),
    };
    cache = new ValkeyCache(valkey, "rc:", 0);
  });

  it("returns null for missing key", async () => {
    expect(await cache.get("k1")).toBeNull();
    expect(valkey.get).toHaveBeenCalledWith("rc:k1");
  });

  it("stores with EX TTL = ttlSeconds + staleTtl", async () => {
    const entry = makeEntry({ ttlSeconds: 300 });
    const stalkyCache = new ValkeyCache(valkey, "rc:", 60);
    await stalkyCache.set("k1", entry);
    expect(valkey.set).toHaveBeenCalledWith("rc:k1", expect.any(String), "EX", 360);
  });

  it("stores with EX = ttlSeconds when no stale window", async () => {
    const entry = makeEntry({ ttlSeconds: 120 });
    await cache.set("k1", entry);
    expect(valkey.set).toHaveBeenCalledWith("rc:k1", expect.any(String), "EX", 120);
  });

  it("round-trips an entry through JSON serialisation", async () => {
    const entry = makeEntry();
    await cache.set("k1", entry);
    const result = await cache.get("k1");
    expect(result).toEqual(entry);
  });

  it("deletes via del with prefix", async () => {
    await cache.delete("k1");
    expect(valkey.del).toHaveBeenCalledWith("rc:k1");
  });

  it("returns null on invalid JSON without throwing", async () => {
    vi.mocked(valkey.get).mockResolvedValueOnce("not-json{{{");
    expect(await cache.get("k1")).toBeNull();
  });

  it("uses custom prefix", async () => {
    const customCache = new ValkeyCache(valkey, "custom:");
    await customCache.get("mykey");
    expect(valkey.get).toHaveBeenCalledWith("custom:mykey");
  });
});

// ─── CachedBodyReadable ───────────────────────────────────────────────────────

describe("CachedBodyReadable", () => {
  const data = { hello: "world" };
  const buf = Buffer.from(JSON.stringify(data));

  it("text() returns UTF-8 string", async () => {
    const r = new CachedBodyReadable(buf);
    expect(await r.text()).toBe(JSON.stringify(data));
  });

  it("json() parses the buffer", async () => {
    const r = new CachedBodyReadable(buf);
    expect(await r.json()).toEqual(data);
  });

  it("bytes() returns Uint8Array", async () => {
    const r = new CachedBodyReadable(buf);
    const bytes = await r.bytes();
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(bytes).toString()).toBe(JSON.stringify(data));
  });

  it("arrayBuffer() wraps the buffer", async () => {
    const r = new CachedBodyReadable(buf);
    const ab = await r.arrayBuffer();
    expect(ab.byteLength).toBe(buf.byteLength);
  });

  it("blob() wraps the buffer", async () => {
    const r = new CachedBodyReadable(buf);
    const blob = await r.blob();
    expect(blob.size).toBe(buf.byteLength);
  });

  it("dump() resolves without reading data", async () => {
    const r = new CachedBodyReadable(buf);
    await expect(r.dump()).resolves.toBeUndefined();
  });

  it("emits data as a readable stream", async () => {
    const r = new CachedBodyReadable(buf);
    const chunks: Buffer[] = [];
    for await (const chunk of r) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    expect(Buffer.concat(chunks).toString()).toBe(JSON.stringify(data));
  });
});
