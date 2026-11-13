import { Redis as Valkey } from "iovalkey";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { integration, meta, proxied, testCase, unique } from "@base/testing";
import type { ServiceProxy } from "@base/testing";

import { CacheAside } from "./cache-aside.js";

/**
 * CacheAside against a real Valkey — NX, PX and the tombstone are the
 * server's behaviour, not a stand-in's — and against one that is unreachable
 * or silent (through Toxiproxy): the cache may be gone, the read may not fail.
 */
const infra = integration("valkey", "toxiproxy");

describe.skipIf(infra.skip)("CacheAside (integration, chaos)", () => {
  meta({
    epic: "nodejs-basics",
    feature: "cache",
    owner: "@team-platform",
    tags: ["cache", "chaos", "integration"],
  });

  const prefix = unique("aside");
  let cache: ServiceProxy;
  /** Straight to Valkey: what is really stored. */
  let direct: Valkey;
  let client: Valkey;
  const warn = vi.fn<(obj: Record<string, unknown>, msg: string) => void>();

  beforeAll(async () => {
    cache = await proxied("valkey");
    direct = new Valkey(infra.url("valkey"));
    client = new Valkey(cache.url, {
      commandTimeout: 300,
      connectTimeout: 300,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      retryStrategy: () => 50,
    });
    client.on("error", () => {});
    await new Promise<void>((resolve) => {
      client.once("ready", resolve);
    });
  });

  afterEach(async () => {
    await cache.reset();
    warn.mockClear();
  });

  afterAll(async () => {
    const keys = await direct.keys(`${prefix}:*`);
    if (keys.length > 0) await direct.del(...keys);
    client.disconnect();
    await direct.quit();
  });

  it("fills with NX and a jittered PX, then serves the stored value", async () => {
    await testCase("NB-1163", "cache-aside against Valkey: fill, TTL, hit");
    const key = `${prefix}:fill`;
    const aside = new CacheAside(client);
    expect(await aside.get(key, 10_000, () => Promise.resolve({ n: 1 }))).toEqual({
      value: { n: 1 },
      hit: false,
    });
    expect(await direct.get(key)).toBe('{"n":1}');
    const ttl = await direct.pttl(key);
    expect(ttl).toBeGreaterThan(8_900);
    expect(ttl).toBeLessThanOrEqual(11_000);
    expect(await aside.get(key, 10_000, () => Promise.reject(new Error("not called")))).toEqual({
      value: { n: 1 },
      hit: true,
    });
  });

  it("a tombstone refuses the stale fill of a reader that raced the write", async () => {
    await testCase("NB-1164", "cache-aside against Valkey: invalidation survives a racing reader");
    const key = `${prefix}:race`;
    const aside = new CacheAside(client);
    let finishLoad!: (v: string) => void;
    const reader = aside.get(
      key,
      10_000,
      () =>
        new Promise<string>((resolve) => {
          finishLoad = resolve;
        }),
    );
    await vi.waitFor(() => {
      expect(finishLoad).toBeDefined();
    });
    // The writer commits and invalidates while the reader still holds the old row.
    await aside.tombstone(key, 2_000);
    finishLoad("old");
    expect((await reader).value).toBe("old");

    expect(await aside.get(key, 10_000, () => Promise.resolve("new"))).toEqual({
      value: "new",
      hit: false,
    });
    expect(await direct.get(key)).not.toBe('"old"');
    expect(await direct.pttl(key)).toBeLessThanOrEqual(2_000);
  });

  it("a cache that is down: the read answers from the source, in bounded time", async () => {
    await testCase("NB-1165", "Valkey unreachable: cache-aside degrades to the loader");
    const aside = new CacheAside(client, { logger: { warn } });
    await cache.down();
    const started = Date.now();
    expect(await aside.get(`${prefix}:down`, 10_000, () => Promise.resolve("from-db"))).toEqual({
      value: "from-db",
      hit: false,
    });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(warn.mock.calls.map((c) => c[1])).toContain("Cache lookup failed, loading from source");
  });

  it("a cache that stops answering: the read waits no longer than the command timeout", async () => {
    await testCase("NB-1166", "Valkey silent: cache-aside is bounded by the command timeout");
    const aside = new CacheAside(client, { logger: { warn } });
    await cache.toxic("timeout", { timeout: 0 });
    const started = Date.now();
    expect(
      (await aside.get(`${prefix}:void`, 10_000, () => Promise.resolve("from-db"))).value,
    ).toBe("from-db");
    // One timed-out lookup and one timed-out fill.
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("caches again once Valkey is back", async () => {
    await testCase("NB-1167", "cache-aside recovers after a Valkey outage");
    const key = `${prefix}:back`;
    const aside = new CacheAside(client);
    await cache.down();
    await aside.get(key, 10_000, () => Promise.resolve("v"));
    await cache.up();
    await expect
      .poll(async () => (await aside.get(key, 10_000, () => Promise.resolve("v"))).hit, {
        timeout: 5_000,
      })
      .toBe(true);
  });
});
