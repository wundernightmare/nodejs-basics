import { afterEach, describe, expect, it, vi } from "vitest";

import { captureMetrics, metricValue, testCase } from "@base/testing";

import {
  encodeEnvelope,
  keyOf,
  parseEnvelope,
  RemoteBreaker,
  TierCache,
  type TierCacheConfig,
  type TierRemote,
} from "./tier-cache.js";

const TOMB = "\u0000tomb";

/** One shared "Valkey": keys with tombstones and a channel, with switches to break it. */
class FakeServer {
  readonly data = new Map<string, string>();
  readonly subscribers = new Set<{ onMessage: (m: string) => void; onSubscribed: () => void }>();
  failing = false;
  hanging = false;
  calls = 0;

  remote(): TierRemote {
    const guard = async (): Promise<void> => {
      this.calls += 1;
      if (this.hanging) await new Promise(() => {});
      if (this.failing) throw new Error("connection refused");
    };
    return {
      get: async (key) => {
        await guard();
        const raw = this.data.get(key);
        return raw === undefined || raw === TOMB ? undefined : raw;
      },
      setNX: async (key, value) => {
        await guard();
        if (this.data.has(key)) return false;
        this.data.set(key, value);
        return true;
      },
      replace: async (key, old, value) => {
        await guard();
        if (this.data.get(key) !== old) return false;
        this.data.set(key, value);
        return true;
      },
      tombstone: async (key) => {
        await guard();
        this.data.set(key, TOMB);
      },
      publish: async (_channel, message) => {
        await guard();
        for (const s of this.subscribers) s.onMessage(message);
      },
      subscribe: (_channel, onMessage, onSubscribed) => {
        const subscriber = { onMessage, onSubscribed };
        this.subscribers.add(subscriber);
        onSubscribed();
        return Promise.resolve(() => {
          this.subscribers.delete(subscriber);
          return Promise.resolve();
        });
      },
    };
  }

  /** The connection dropped and came back: every subscription is re-established. */
  reconnect(): void {
    for (const s of this.subscribers) s.onSubscribed();
  }
}

/** The source of truth: versioned rows, a call counter, a switch to fail. */
class Source {
  readonly rows = new Map<string, number>();
  loads = 0;
  failing = false;
  gate: Promise<void> | undefined;

  readonly load = async (key: string): Promise<{ key: string; version: number } | undefined> => {
    this.loads += 1;
    const version = this.rows.get(key); // read first: what a query that began before the write sees
    if (this.gate !== undefined) await this.gate;
    if (this.failing) throw new Error("source is down");
    return version === undefined ? undefined : { key, version };
  };
}

interface Rig {
  cache: TierCache<{ key: string; version: number }>;
  source: Source;
  advance(ms: number): void;
  warn: ReturnType<typeof vi.fn<(obj: Record<string, unknown>, msg: string) => void>>;
}

const open: Array<TierCache<{ key: string; version: number }>> = [];
let clock = 1_000_000;

function rig(server: FakeServer | undefined, config: Partial<TierCacheConfig> = {}): Rig {
  const source = new Source();
  const warn = vi.fn<(obj: Record<string, unknown>, msg: string) => void>();
  const cache = new TierCache<{ key: string; version: number }>(
    { name: "t", softTtlMs: 1_000, hardTtlMs: 10_000, ...config },
    source.load,
    server?.remote(),
    { now: () => clock, random: () => 0.5, logger: { warn } },
  );
  open.push(cache);
  return {
    cache,
    source,
    warn,
    advance: (ms) => {
      clock += ms;
    },
  };
}

const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

afterEach(async () => {
  await Promise.all(open.splice(0).map((cache) => cache.close()));
});

function build(config: TierCacheConfig): TierCache<number> {
  return new TierCache<number>(config, () => Promise.resolve(1));
}

describe("tier cache envelope", () => {
  it("round-trips and rejects what it did not write", async () => {
    await testCase("NB-1172", "tier cache: envelope carries both deadlines and is never trusted");
    expect(parseEnvelope(encodeEnvelope(5, 9, '{"a":"x|y"}'))).toEqual({
      softMs: 5,
      hardMs: 9,
      payload: '{"a":"x|y"}',
    });
    for (const bad of ["", "2|1|2|x", "1|9|5|x", "1|a|2|x", "1|1|2", '{"a":1}', "1|-1|2|x"]) {
      expect(parseEnvelope(bad)).toBeUndefined();
    }
  });
});

describe("RemoteBreaker", () => {
  it("opens after consecutive failures and re-opens on one failed probe", async () => {
    await testCase(
      "NB-1173",
      "tier cache: L2 breaker opens, cools down, re-opens on a failed probe",
    );
    const breaker = new RemoteBreaker(3, 1_000);
    expect([breaker.record(0, true), breaker.record(0, true)]).toEqual([false, false]);
    expect(breaker.record(0, false)).toBe(false); // a success resets the count
    expect([breaker.record(0, true), breaker.record(0, true), breaker.record(0, true)]).toEqual([
      false,
      false,
      true,
    ]);
    expect(breaker.allow(999)).toBe(false);
    expect(breaker.allow(1_000)).toBe(true);
    expect(breaker.record(1_000, true)).toBe(true);
    expect(breaker.allow(1_500)).toBe(false);
  });
});

describe("TierCache", () => {
  it("serves a fresh value from L1 alone", async () => {
    await testCase("NB-1174", "tier cache: a fresh value costs no I/O");
    const server = new FakeServer();
    const { cache, source } = rig(server);
    source.rows.set("k", 1);

    expect(await cache.get("k")).toEqual({ key: "k", version: 1 });
    const calls = server.calls;
    expect(await cache.get("k")).toEqual({ key: "k", version: 1 });
    expect(source.loads).toBe(1);
    expect(server.calls).toBe(calls);
  });

  it("serves a stale value and refreshes it behind", async () => {
    await testCase("NB-1175", "tier cache: stale-while-revalidate between soft and hard TTL");
    const server = new FakeServer();
    const { cache, source, advance } = rig(server);
    source.rows.set("k", 1);
    await cache.get("k");

    source.rows.set("k", 2);
    advance(1_500);
    expect(await cache.get("k")).toEqual({ key: "k", version: 1 });
    await settle();
    expect(await cache.get("k")).toEqual({ key: "k", version: 2 });
    expect(source.loads).toBe(2);
    // The refresh replaced the shared value too.
    expect(parseEnvelope(server.data.get("tc:t:k") ?? "")?.payload).toBe('{"key":"k","version":2}');
  });

  it("never serves a value past its hard deadline", async () => {
    await testCase("NB-1176", "tier cache: past the hard TTL the value is loaded synchronously");
    const { cache, source, advance } = rig(undefined);
    source.rows.set("k", 1);
    await cache.get("k");
    source.rows.set("k", 2);
    advance(10_001);
    expect(await cache.get("k")).toEqual({ key: "k", version: 2 });
  });

  it("shares one lookup between concurrent callers", async () => {
    await testCase("NB-1177", "tier cache: one lookup per key however many callers");
    const { cache, source } = rig(new FakeServer());
    source.rows.set("k", 1);
    const got = await Promise.all(Array.from({ length: 20 }, () => cache.get("k")));
    expect(got.every((v) => v?.version === 1)).toBe(true);
    expect(source.loads).toBe(1);
  });

  it("serves an expired value while the source fails, for the grace only", async () => {
    await testCase(
      "NB-1178",
      "tier cache: stale-if-error serves an expired value for its grace only",
    );
    const { cache, source, advance, warn } = rig(undefined, { staleIfErrorMs: 5_000 });
    source.rows.set("k", 1);
    await cache.get("k");

    source.failing = true;
    advance(12_000);
    expect(await cache.get("k")).toEqual({ key: "k", version: 1 });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ "cache.name": "t" }),
      "tiercache: source failed, serving an expired value",
    );
    advance(5_000);
    await expect(cache.get("k")).rejects.toThrow("source is down");
  });

  it("falls back to an expired L2 value when L1 has none", async () => {
    await testCase(
      "NB-1178",
      "tier cache: stale-if-error serves an expired value for its grace only",
    );
    const server = new FakeServer();
    const first = rig(server, { staleIfErrorMs: 5_000 });
    first.source.rows.set("k", 1);
    await first.cache.get("k");

    const second = rig(server, { staleIfErrorMs: 5_000 });
    second.source.failing = true;
    second.advance(12_000);
    expect(await second.cache.get("k")).toEqual({ key: "k", version: 1 });
  });

  it("without the grace an expired value is an error when the source fails", async () => {
    await testCase(
      "NB-1178",
      "tier cache: stale-if-error serves an expired value for its grace only",
    );
    const { cache, source, advance } = rig(undefined);
    source.rows.set("k", 1);
    await cache.get("k");
    source.failing = true;
    advance(10_001);
    await expect(cache.get("k")).rejects.toThrow("source is down");
  });

  it("answers from the loader while L2 fails, then skips L2", async () => {
    await testCase("NB-1179", "tier cache: an unreachable L2 never fails a read");
    const server = new FakeServer();
    server.failing = true;
    const { cache, source, warn } = rig(server, { breakerThreshold: 2 });
    for (const key of ["a", "b", "c"]) source.rows.set(key, 1);

    expect(await cache.get("a")).toEqual({ key: "a", version: 1 });
    const calls = server.calls;
    expect(await cache.get("b")).toEqual({ key: "b", version: 1 });
    expect(await cache.get("c")).toEqual({ key: "c", version: 1 });
    expect(server.calls).toBe(calls); // open: L2 is not asked any more
    expect(await cache.get("a")).toEqual({ key: "a", version: 1 }); // L1 kept what it loaded
    expect(source.loads).toBe(3);
    expect(warn).toHaveBeenCalledWith(expect.anything(), "tiercache: L2 is failing, skipping it");
  });

  it("bounds an L2 that does not answer", async () => {
    await testCase("NB-1179", "tier cache: an unreachable L2 never fails a read");
    const server = new FakeServer();
    server.hanging = true;
    const { cache, source } = rig(server, { remoteTimeoutMs: 20, breakerThreshold: 1 });
    source.rows.set("k", 1);
    const started = performance.now();
    expect(await cache.get("k")).toEqual({ key: "k", version: 1 });
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("uses L2 again after the cooldown", async () => {
    await testCase("NB-1180", "tier cache: L2 is picked up again after the breaker cooldown");
    const server = new FakeServer();
    server.failing = true;
    const { cache, source, advance } = rig(server, {
      breakerThreshold: 1,
      breakerCooldownMs: 1_000,
    });
    source.rows.set("a", 1);
    source.rows.set("b", 1);
    await cache.get("a");

    server.failing = false;
    advance(1_000);
    await cache.get("b");
    expect(server.data.has("tc:t:b")).toBe(true);
  });

  it("shares a value between processes with its deadlines", async () => {
    await testCase("NB-1181", "tier cache: L2 shares a value and its deadlines between processes");
    const server = new FakeServer();
    const first = rig(server);
    const second = rig(server);
    first.source.rows.set("k", 1);
    await first.cache.get("k");

    expect(await second.cache.get("k")).toEqual({ key: "k", version: 1 });
    expect(second.source.loads).toBe(0);
    // The copy keeps the original deadlines: stale for the second process when it is for the first.
    second.source.rows.set("k", 2);
    second.advance(1_500);
    expect(await second.cache.get("k")).toEqual({ key: "k", version: 1 });
    await settle();
    expect(second.source.loads).toBe(1);
  });

  it("invalidates every process", async () => {
    await testCase(
      "NB-1182",
      "tier cache: invalidate reaches L1 of every process and tombstones L2",
    );
    const server = new FakeServer();
    const writer = rig(server);
    const reader = rig(server);
    for (const r of [writer, reader]) r.source.rows.set("k", 1);
    await writer.cache.get("k");
    await reader.cache.get("k");

    for (const r of [writer, reader]) r.source.rows.set("k", 2);
    await writer.cache.invalidate("k");
    expect(server.data.get("tc:t:k")).toBe(TOMB);
    expect(await reader.cache.get("k")).toEqual({ key: "k", version: 2 });
    expect(await writer.cache.get("k")).toEqual({ key: "k", version: 2 });
  });

  it("does not cache a load that raced an invalidation", async () => {
    await testCase("NB-1183", "tier cache: a load racing an invalidation is not cached anywhere");
    const server = new FakeServer();
    const { cache, source } = rig(server);
    source.rows.set("k", 1);
    let release!: () => void;
    source.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const reading = cache.get("k"); // has read the old row, not yet written it back
    await settle();
    source.rows.set("k", 2);
    await cache.invalidate("k");
    release();
    expect(await reading).toEqual({ key: "k", version: 1 }); // the reader's own answer
    source.gate = undefined;

    expect(server.data.get("tc:t:k")).toBe(TOMB); // the fill was refused
    expect(await cache.get("k")).toEqual({ key: "k", version: 2 }); // and L1 did not keep it
  });

  it("does not keep an L2 hit that raced a published invalidation", async () => {
    await testCase("NB-1183", "tier cache: a load racing an invalidation is not cached anywhere");
    const server = new FakeServer();
    const writer = rig(server);
    writer.source.rows.set("k", 1);
    await writer.cache.get("k");

    const reader = rig(server);
    reader.source.rows.set("k", 2);
    const remoteGet = server.data.get.bind(server.data);
    // The invalidation lands while the reader's L2 lookup is in the air.
    vi.spyOn(server.data, "get").mockImplementationOnce((key) => {
      const value = remoteGet(key);
      for (const s of server.subscribers) s.onMessage("k");
      return value;
    });
    expect(await reader.cache.get("k")).toEqual({ key: "k", version: 1 }); // its own answer
    expect(reader.source.loads).toBe(0);

    // L1 did not keep the raced value: the next read goes to L2 again.
    const calls = server.calls;
    await reader.cache.get("k");
    expect(server.calls).toBe(calls + 1);
    // And that one, read after the invalidation, is kept.
    await reader.cache.get("k");
    expect(server.calls).toBe(calls + 1);
  });

  it("empties L1 when the subscription is re-established", async () => {
    await testCase("NB-1184", "tier cache: a reconnected subscription empties L1");
    const server = new FakeServer();
    const { cache, source } = rig(server);
    source.rows.set("k", 1);
    await cache.get("k");
    server.data.clear();
    source.rows.set("k", 2);

    server.reconnect();
    expect(await cache.get("k")).toEqual({ key: "k", version: 2 });
  });

  it("has no subscription when invalidation is disabled", async () => {
    await testCase("NB-1184", "tier cache: a reconnected subscription empties L1");
    const server = new FakeServer();
    const { cache, source } = rig(server, { disableInvalidation: true });
    source.rows.set("k", 1);
    await cache.get("k");
    expect(server.subscribers.size).toBe(0);
    await cache.invalidate("k");
    expect(server.data.get("tc:t:k")).toBe(TOMB);
  });

  it("does not cache 'not found' and stops serving a deleted row", async () => {
    await testCase(
      "NB-1185",
      "tier cache: not found is not cached, a deleted row stops being served",
    );
    const server = new FakeServer();
    const { cache, source, advance } = rig(server);
    expect(await cache.get("k")).toBeUndefined();
    expect(await cache.get("k")).toBeUndefined();
    expect(source.loads).toBe(2);

    source.rows.set("k", 1);
    expect(await cache.get("k")).toEqual({ key: "k", version: 1 });
    source.rows.delete("k");
    advance(1_500); // stale: served once more, the refresh finds it gone
    expect(await cache.get("k")).toEqual({ key: "k", version: 1 });
    await settle();
    expect(await cache.get("k")).toBeUndefined();
    expect(server.data.get("tc:t:k")).toBe(TOMB);
  });

  it("replaces a corrupt L2 entry", async () => {
    await testCase("NB-1186", "tier cache: corrupt L2 entries are replaced, never served");
    const server = new FakeServer();
    const { cache, source } = rig(server);
    source.rows.set("a", 1);
    source.rows.set("b", 1);
    server.data.set("tc:t:a", "not an envelope");
    server.data.set("tc:t:b", encodeEnvelope(clock + 1_000, clock + 2_000, "{not json"));

    expect(await cache.get("a")).toEqual({ key: "a", version: 1 });
    expect(await cache.get("b")).toEqual({ key: "b", version: 1 });
    expect(parseEnvelope(server.data.get("tc:t:a") ?? "")?.payload).toBe('{"key":"a","version":1}');
    expect(parseEnvelope(server.data.get("tc:t:b") ?? "")?.payload).toBe('{"key":"b","version":1}');
  });

  it("stays within its capacity, evicting the oldest", async () => {
    await testCase("NB-1187", "tier cache: L1 stays within its byte budget");
    const capture = captureMetrics();
    try {
      const { cache, source } = rig(undefined, { name: "cap", maxBytes: 300, maxEntryBytes: 200 });
      for (let i = 0; i < 20; i += 1) source.rows.set(`key-${i}`, i);
      for (let i = 0; i < 20; i += 1) await cache.get(`key-${i}`);

      const text = await capture.scrape();
      const bytes = metricValue(text, "tiercache_l1_bytes", { cache: "cap" });
      expect(bytes).toBeGreaterThan(0);
      expect(bytes).toBeLessThanOrEqual(300);

      const loads = source.loads;
      await cache.get("key-19"); // the newest is still there
      await cache.get("key-0"); // the oldest is not
      expect(source.loads).toBe(loads + 1);
    } finally {
      await capture.stop();
    }
  });

  it("serves an entry too large for L1 from L2", async () => {
    await testCase("NB-1188", "tier cache: an oversize entry is served from L2 and counted");
    const capture = captureMetrics();
    try {
      const server = new FakeServer();
      const { cache, source } = rig(server, { name: "big", maxEntryBytes: 20 });
      source.rows.set("k", 1);
      await cache.get("k");
      await cache.get("k");
      expect(source.loads).toBe(1);

      const text = await capture.scrape();
      expect(metricValue(text, "tiercache_l1_oversize_total", { cache: "big" })).toBe(2);
      expect(metricValue(text, "tiercache_reads_total", { cache: "big", result: "load" })).toBe(1);
      expect(metricValue(text, "tiercache_reads_total", { cache: "big", result: "l2" })).toBe(1);
    } finally {
      await capture.stop();
    }
  });

  it("bounds the background refreshes", async () => {
    await testCase("NB-1189", "tier cache: background refreshes are bounded and one per key");
    const capture = captureMetrics();
    try {
      const { cache, source, advance } = rig(undefined, { name: "ref", refreshConcurrency: 2 });
      for (const key of ["a", "b", "c"]) source.rows.set(key, 1);
      for (const key of ["a", "b", "c"]) await cache.get(key);

      let release!: () => void;
      source.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      advance(1_500);
      for (const key of ["a", "a", "b", "c", "c"]) await cache.get(key);
      await settle();
      expect(source.loads).toBe(3 + 2); // a and b; c found the limit reached

      release();
      await settle();
      const text = await capture.scrape();
      const refreshes = (result: string): number =>
        metricValue(text, "tiercache_refreshes_total", { cache: "ref", result });
      expect([refreshes("ok"), refreshes("dropped")]).toEqual([2, 2]);
      expect(metricValue(text, "tiercache_reads_total", { cache: "ref", result: "stale" })).toBe(5);
    } finally {
      await capture.stop();
    }
  });

  it("keeps the stale value when a refresh fails", async () => {
    await testCase("NB-1190", "tier cache: a failed refresh keeps the stale value");
    const { cache, source, advance, warn } = rig(undefined);
    source.rows.set("k", 1);
    await cache.get("k");
    source.failing = true;
    advance(1_500);
    expect(await cache.get("k")).toEqual({ key: "k", version: 1 });
    await settle();
    expect(await cache.get("k")).toEqual({ key: "k", version: 1 });
    expect(warn).toHaveBeenCalledWith(
      expect.anything(),
      "tiercache: background refresh failed, the stale value stays",
    );
  });

  it("lets each caller give up on its own", async () => {
    await testCase("NB-1191", "tier cache: each caller honours its own signal");
    const { cache, source } = rig(undefined);
    source.rows.set("k", 1);
    let release!: () => void;
    source.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const impatient = new AbortController();
    const first = cache.get("k", impatient.signal);
    const second = cache.get("k");
    impatient.abort(new Error("caller gave up"));
    await expect(first).rejects.toThrow("caller gave up");
    release();
    expect(await second).toEqual({ key: "k", version: 1 });
    expect(source.loads).toBe(1);
    await expect(cache.get("k", AbortSignal.abort(new Error("already gone")))).resolves.toEqual({
      key: "k",
      version: 1,
    }); // a fresh L1 value needs no waiting
  });

  it("aborts the loader of a running refresh on close", async () => {
    await testCase("NB-1192", "tier cache: close stops the running refreshes");
    const seen: AbortSignal[] = [];
    let version = 1;
    const cache = new TierCache<number>(
      { name: "closing", softTtlMs: 1_000, hardTtlMs: 10_000 },
      (_key, signal) => {
        seen.push(signal);
        if (version === 1) return Promise.resolve(version);
        return new Promise<number>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(signal.reason as Error);
          });
        });
      },
      undefined,
      { now: () => clock },
    );
    await cache.get("k");
    version = 2;
    clock += 1_500;
    await cache.get("k");
    await settle();
    await cache.close();
    expect(seen.at(-1)?.aborted).toBe(true);
  });

  it("rejects a config it cannot run with", async () => {
    await testCase("NB-1193", "tier cache: invalid config is rejected at construction");
    expect(() => build({ name: "", hardTtlMs: 1 })).toThrow("name is required");
    expect(() => build({ name: "x", hardTtlMs: 0 })).toThrow("hardTtlMs must be positive");
    expect(() => build({ name: "x", hardTtlMs: 5, softTtlMs: 6 })).toThrow("must not exceed");
    expect(() => build({ name: "x", hardTtlMs: 5, staleIfErrorMs: -1 })).toThrow(
      "must not be negative",
    );
  });

  it("derives a fixed-size key", async () => {
    await testCase("NB-1193", "tier cache: invalid config is rejected at construction");
    expect(keyOf("api-key-1")).toHaveLength(43);
    expect(keyOf("api-key-1")).toBe(keyOf("api-key-1"));
    expect(keyOf("api-key-1")).not.toBe(keyOf("api-key-2"));
  });
});
