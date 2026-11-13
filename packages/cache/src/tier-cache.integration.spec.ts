import { Redis as Valkey } from "iovalkey";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { integration, meta, proxied, testCase, unique } from "@base/testing";
import type { ServiceProxy } from "@base/testing";

import { parseEnvelope, TierCache, type TierCacheConfig } from "./tier-cache.js";
import { ValkeyRemote } from "./tier-cache.valkey.js";

/**
 * TierCache with a real Valkey as L2 — IFEQ, NX, the tombstone and Pub/Sub
 * are the server's behaviour — and with one that refuses, hangs or cuts its
 * replies (through Toxiproxy): every read answers, correctly, within a bound,
 * and L2 is picked up again afterwards. The counterpart of golang-basics'
 * tiercache integration_test.go and chaos_test.go.
 */
const infra = integration("valkey", "toxiproxy");

interface Row {
  key: string;
  version: number;
}

/** How long a read may take while Valkey misbehaves: two L2 calls at 200 ms, the loader, slack. */
const READ_BOUND_MS = 2_000;

describe.skipIf(infra.skip)("TierCache (integration, chaos)", () => {
  meta({
    epic: "nodejs-basics",
    feature: "cache",
    owner: "@team-platform",
    tags: ["cache", "chaos", "integration"],
  });

  let proxy: ServiceProxy;
  /** Straight to Valkey: what is really stored. */
  let direct: Valkey;
  const clients: Valkey[] = [];
  const caches: Array<TierCache<Row>> = [];
  const names: string[] = [];

  async function connect(url: string): Promise<Valkey> {
    const client = new Valkey(url, {
      commandTimeout: 200,
      connectTimeout: 300,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      retryStrategy: () => 50,
    });
    client.on("error", () => {});
    clients.push(client);
    await new Promise<void>((resolve) => {
      client.once("ready", resolve);
    });
    return client;
  }

  /** One "process": its own connection, its own source of truth view, its own L1. */
  async function process_(
    url: string,
    name: string,
    rows: Map<string, number>,
    config: Partial<TierCacheConfig> = {},
  ): Promise<{ cache: TierCache<Row>; loads: () => number }> {
    let loads = 0;
    const cache = new TierCache<Row>(
      { name, hardTtlMs: 60_000, remoteTimeoutMs: 200, ...config },
      (key) => {
        loads += 1;
        const version = rows.get(key);
        return Promise.resolve(version === undefined ? undefined : { key, version });
      },
      new ValkeyRemote(await connect(url)),
    );
    caches.push(cache);
    return { cache, loads: () => loads };
  }

  function cacheName(): string {
    const name = unique("tier");
    names.push(name);
    return name;
  }

  /** Waits until `count` subscriptions to the cache's channel are acknowledged. */
  async function subscribed(name: string, count: number): Promise<void> {
    const channel = `tc:${name}:inv`;
    await expect.poll(() => direct.pubsub("NUMSUB", channel)).toEqual([channel, count]);
  }

  beforeAll(async () => {
    proxy = await proxied("valkey");
    direct = new Valkey(infra.url("valkey"));
  });

  afterEach(async () => {
    await proxy.reset();
    await Promise.all(caches.splice(0).map((cache) => cache.close()));
    for (const client of clients.splice(0)) client.disconnect();
  });

  afterAll(async () => {
    for (const name of names) {
      const keys = await direct.keys(`tc:${name}:*`);
      if (keys.length > 0) await direct.del(...keys);
    }
    await direct.quit();
  });

  it("shares a value between processes, with its TTL", async () => {
    await testCase("NB-1194", "tier cache against Valkey: a value and its TTL are shared");
    const name = cacheName();
    const rows = new Map([["k", 1]]);
    const first = await process_(infra.url("valkey"), name, rows);
    const second = await process_(infra.url("valkey"), name, rows);

    expect(await first.cache.get("k")).toEqual({ key: "k", version: 1 });
    expect(await second.cache.get("k")).toEqual({ key: "k", version: 1 });
    expect(second.loads()).toBe(0);
    const ttl = await direct.pttl(`tc:${name}:k`);
    expect(ttl).toBeGreaterThan(53_000);
    expect(ttl).toBeLessThanOrEqual(66_000);
  });

  it("an invalidation reaches the other process", async () => {
    await testCase("NB-1195", "tier cache against Valkey: Pub/Sub invalidation reaches every L1");
    const name = cacheName();
    const rows = new Map([["k", 1]]);
    const writer = await process_(infra.url("valkey"), name, rows);
    const reader = await process_(infra.url("valkey"), name, rows);
    await reader.cache.get("k");
    // The reader's subscription must be acknowledged before the publish.
    await subscribed(name, 2);
    // The acknowledgement emptied L1; warm it again.
    await reader.cache.get("k");

    rows.set("k", 2);
    await writer.cache.invalidate("k");
    await expect
      .poll(async () => (await reader.cache.get("k"))?.version, { timeout: 5_000 })
      .toBe(2);
  });

  it("a refresh replaces the shared value (SET IFEQ)", async () => {
    await testCase(
      "NB-1196",
      "tier cache against Valkey: a refresh replaces the value it started from",
    );
    const name = cacheName();
    const rows = new Map([["k", 1]]);
    const { cache } = await process_(infra.url("valkey"), name, rows, { softTtlMs: 50 });
    await subscribed(name, 1); // the acknowledgement empties L1: wait for it first
    await cache.get("k");
    rows.set("k", 2);
    await new Promise((resolve) => {
      setTimeout(resolve, 80);
    });
    expect((await cache.get("k"))?.version).toBe(1); // stale, refreshed behind
    await expect
      .poll(async () => parseEnvelope((await direct.get(`tc:${name}:k`)) ?? "")?.payload)
      .toBe('{"key":"k","version":2}');
    await expect.poll(async () => (await cache.get("k"))?.version).toBe(2);
  });

  it("a tombstone refuses the fill of a reader that raced the write", async () => {
    await testCase("NB-1197", "tier cache against Valkey: invalidation survives a racing reader");
    const name = cacheName();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let version = 1;
    let loads = 0;
    const cache = new TierCache<Row>(
      { name, hardTtlMs: 60_000, tombstoneTtlMs: 2_000 },
      async (key) => {
        loads += 1;
        const read = version;
        if (loads === 1) await gate;
        return { key, version: read };
      },
      new ValkeyRemote(await connect(infra.url("valkey"))),
    );
    caches.push(cache);

    const reading = cache.get("k");
    await expect.poll(() => loads).toBe(1);
    version = 2;
    await cache.invalidate("k"); // the writer commits and invalidates
    release();
    expect((await reading)?.version).toBe(1);

    expect((await cache.get("k"))?.version).toBe(2);
    expect(parseEnvelope((await direct.get(`tc:${name}:k`)) ?? "")).toBeUndefined(); // still the tombstone
  });

  it("Valkey down: every read answers from the source, in bounded time, then L2 is skipped", async () => {
    await testCase("NB-1198", "Valkey unreachable: the tier cache degrades to L1 and the loader");
    const name = cacheName();
    const rows = new Map(Array.from({ length: 20 }, (_, i) => [`k${i}`, 1] as const));
    const { cache, loads } = await process_(proxy.url, name, rows, { breakerThreshold: 3 });
    await proxy.down();

    for (const key of rows.keys()) {
      const started = Date.now();
      expect(await cache.get(key)).toEqual({ key, version: 1 });
      expect(Date.now() - started).toBeLessThan(READ_BOUND_MS);
    }
    expect(loads()).toBe(20);
    // L1 kept what it loaded: no second load, no L2.
    for (const key of rows.keys()) await cache.get(key);
    expect(loads()).toBe(20);
  });

  it.each([
    ["silent", "timeout", { timeout: 0 }],
    ["resetting connections", "reset_peer", { timeout: 0 }],
    ["cutting replies short", "limit_data", { bytes: 3 }],
    ["slow", "latency", { latency: 1_000 }],
  ] as const)("Valkey %s: reads stay correct and bounded", async (_label, toxic, attributes) => {
    await testCase("NB-1199", "Valkey misbehaving: tier cache reads stay correct and bounded");
    const name = cacheName();
    const rows = new Map(Array.from({ length: 8 }, (_, i) => [`k${i}`, 1] as const));
    const { cache } = await process_(proxy.url, name, rows, { breakerThreshold: 2 });
    await proxy.toxic(toxic, attributes);

    for (const key of rows.keys()) {
      const started = Date.now();
      expect(await cache.get(key)).toEqual({ key, version: 1 });
      expect(Date.now() - started).toBeLessThan(READ_BOUND_MS);
    }
  });

  it("uses L2 again once Valkey is back", async () => {
    await testCase("NB-1200", "tier cache recovers L2 after a Valkey outage");
    const name = cacheName();
    const rows = new Map<string, number>();
    const { cache } = await process_(proxy.url, name, rows, {
      breakerThreshold: 2,
      breakerCooldownMs: 300,
    });
    await proxy.down();
    for (const key of ["a", "b", "c"]) {
      rows.set(key, 1);
      await cache.get(key);
    }
    await proxy.up();

    // A value loaded now reaches a process that can only get it from Valkey.
    const other = await process_(infra.url("valkey"), name, new Map());
    let attempt = 0;
    await expect
      .poll(
        async () => {
          attempt += 1;
          const key = `recovery-${attempt}`;
          rows.set(key, 1);
          await cache.get(key);
          return (await other.cache.get(key))?.version;
        },
        { timeout: 15_000, interval: 100 },
      )
      .toBe(1);
  });

  it("a subscription that was cut empties L1 when it is back", async () => {
    await testCase("NB-1201", "tier cache: a re-established subscription empties L1");
    const name = cacheName();
    const rows = new Map([["k", 1]]);
    const { cache, loads } = await process_(proxy.url, name, rows);
    await subscribed(name, 1);
    await cache.get("k");
    const before = loads();

    await proxy.down(); // drops the subscription: invalidations published now are lost
    rows.set("k", 2);
    await direct.del(`tc:${name}:k`);
    await proxy.up();

    await expect
      .poll(async () => (await cache.get("k"))?.version, { timeout: 10_000, interval: 100 })
      .toBe(2);
    expect(loads()).toBeGreaterThan(before);
  });
});
