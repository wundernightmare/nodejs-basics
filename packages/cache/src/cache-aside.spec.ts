import { describe, expect, it, vi } from "vitest";

import { captureMetrics, metricValue, testCase } from "@base/testing";

import { CacheAside, jitter } from "./cache-aside.js";
import type { AsideClient } from "./cache-aside.js";

/** A Valkey stand-in with the two commands the helper uses and their NX / PX meaning. */
function memory(): AsideClient & {
  data: Map<string, string>;
  sets: Array<Array<string | number>>;
} {
  const data = new Map<string, string>();
  const sets: Array<Array<string | number>> = [];
  return {
    data,
    sets,
    get: (key) => Promise.resolve(data.get(key) ?? null),
    set: (key: string, value: string, ...args: Array<string | number>) => {
      sets.push([key, value, ...args]);
      if (args.includes("NX") && data.has(key)) return Promise.resolve(null);
      data.set(key, value);
      return Promise.resolve("OK");
    },
  };
}

describe("jitter", () => {
  it("spreads a TTL over ±10 %", async () => {
    await testCase("NB-1137", "cache TTLs are jittered by ±10 %");
    expect(jitter(1_000, () => 0)).toBe(900);
    expect(jitter(1_000, () => 0.5)).toBe(1_000);
    expect(jitter(1_000, () => 0.999_999)).toBe(1_100);
    expect(jitter(5, () => 0)).toBe(5);
    expect(jitter(0, () => 0)).toBe(0);
  });
});

describe("CacheAside", () => {
  it("loads on a miss, fills with SET NX and a jittered TTL, then hits", async () => {
    await testCase("NB-1138", "cache-aside: miss → load → fill → hit");
    const client = memory();
    const cache = new CacheAside(client, { random: () => 0 });
    const load = vi.fn(() => Promise.resolve({ id: 1, title: "a" }));

    expect(await cache.get("k", 1_000, load)).toEqual({ value: { id: 1, title: "a" }, hit: false });
    expect(client.sets).toEqual([["k", '{"id":1,"title":"a"}', "PX", 900, "NX"]]);
    expect(await cache.get("k", 1_000, load)).toEqual({ value: { id: 1, title: "a" }, hit: true });
    expect(load).toHaveBeenCalledOnce();
  });

  it("shares one load between concurrent misses on a key", async () => {
    await testCase("NB-1139", "cache-aside: singleflight");
    const cache = new CacheAside(memory());
    let release!: (v: string) => void;
    const load = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const waiters = [1, 2, 3].map(() => cache.get("hot", 1_000, load));
    const other = cache.get("cold", 1_000, () => Promise.resolve("other"));
    await vi.waitFor(() => {
      expect(load).toHaveBeenCalled();
    });
    release("v");
    expect(await Promise.all(waiters)).toEqual([
      { value: "v", hit: false },
      { value: "v", hit: false },
      { value: "v", hit: false },
    ]);
    expect((await other).value).toBe("other");
    expect(load).toHaveBeenCalledOnce();
  });

  it("a failed load is thrown to every waiter and not remembered", async () => {
    await testCase("NB-1139", "cache-aside: singleflight");
    const cache = new CacheAside(memory());
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValue("ok");
    await expect(cache.get("k", 1_000, load)).rejects.toThrow("db down");
    expect((await cache.get("k", 1_000, load)).value).toBe("ok");
  });

  it("a tombstone reads as a miss and a racing fill cannot overwrite it", async () => {
    await testCase("NB-1140", "cache-aside: an invalidation is not undone by a stale fill");
    const client = memory();
    const cache = new CacheAside(client);
    await cache.get("k", 1_000, () => Promise.resolve("old"));

    // A reader loads the old value, the writer invalidates, the reader fills.
    let release!: (v: string) => void;
    client.data.delete("k");
    const stale = cache.get(
      "k",
      1_000,
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    await vi.waitFor(() => {
      expect(release).toBeDefined();
    });
    await cache.tombstone("k", 5_000);
    release("old");
    expect((await stale).value).toBe("old");

    expect(await cache.get("k", 1_000, () => Promise.resolve("new"))).toEqual({
      value: "new",
      hit: false,
    });
    expect(client.sets.at(1)).toEqual(["k", "\u0000valkey:tombstone", "PX", 5_000]);
    await expect(cache.tombstone("k", 0)).rejects.toThrow("ttl must be positive");
  });

  it("a cache that is down or corrupt never fails a read", async () => {
    await testCase("NB-1141", "cache-aside: the source of truth always wins");
    const warn = vi.fn<(obj: Record<string, unknown>, msg: string) => void>();
    const down: AsideClient = {
      get: () => Promise.reject(new Error("ECONNREFUSED")),
      set: () => Promise.reject(new Error("ECONNREFUSED")),
    };
    const cache = new CacheAside(down, { logger: { warn } });
    expect(await cache.get("k", 1_000, () => Promise.resolve(7))).toEqual({ value: 7, hit: false });
    expect(warn.mock.calls.map((c) => c[1])).toEqual([
      "Cache lookup failed, loading from source",
      "Cache write failed",
    ]);

    const client = memory();
    client.data.set("bad", "{not json");
    const corrupt = new CacheAside(client, { logger: { warn } });
    expect((await corrupt.get("bad", 1_000, () => Promise.resolve("fresh"))).value).toBe("fresh");

    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect((await corrupt.get("c", 1_000, () => Promise.resolve(cyclic))).value).toBe(cyclic);
    expect((await corrupt.get("u", 1_000, () => Promise.resolve(undefined))).value).toBeUndefined();
    expect(client.data.has("c") || client.data.has("u")).toBe(false);
  });

  it("counts lookups by result", async () => {
    await testCase("NB-1142", "cache_lookups_total{result} — the metric golang-basics exports");
    const capture = captureMetrics();
    try {
      const client = memory();
      const cache = new CacheAside(client);
      await cache.get("k", 1_000, () => Promise.resolve(1));
      await cache.get("k", 1_000, () => Promise.resolve(1));
      await cache.get("k", 1_000, () => Promise.resolve(1));
      const broken = new CacheAside({ ...client, get: () => Promise.reject(new Error("x")) });
      await broken.get("k", 1_000, () => Promise.resolve(1));
      const text = await capture.scrape();
      const lookups = (result: string): number =>
        metricValue(text, "cache_lookups_total", { result });
      expect([lookups("hit"), lookups("miss"), lookups("error")]).toEqual([2, 1, 1]);
    } finally {
      await capture.stop();
    }
  });
});
