import type { Meter } from "@opentelemetry/api";
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
  readonly subscribers = new Set<{
    channel: string;
    onMessage: (m: string) => void;
    onSubscribed: () => void;
  }>();
  /** Every command that reached the server, as "<name> <key or channel> <ttl ms or message>". */
  readonly ops: string[] = [];
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
      setNX: async (key, value, ttlMs) => {
        await guard();
        this.ops.push(`setNX ${key} ${ttlMs}`);
        if (this.data.has(key)) return false;
        this.data.set(key, value);
        return true;
      },
      replace: async (key, old, value, ttlMs) => {
        await guard();
        this.ops.push(`replace ${key} ${ttlMs}`);
        if (this.data.get(key) !== old) return false;
        this.data.set(key, value);
        return true;
      },
      tombstone: async (key, ttlMs) => {
        await guard();
        this.ops.push(`tombstone ${key} ${ttlMs}`);
        this.data.set(key, TOMB);
      },
      publish: async (channel, message) => {
        await guard();
        this.ops.push(`publish ${channel} ${message}`);
        for (const s of this.subscribers) if (s.channel === channel) s.onMessage(message);
      },
      subscribe: (channel, onMessage, onSubscribed) => {
        const subscriber = { channel, onMessage, onSubscribed };
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
    // soft == hard is plain cache-aside, not a broken envelope.
    expect(parseEnvelope("1|5|5|x")).toEqual({ softMs: 5, hardMs: 5, payload: "x" });
    for (const bad of [
      "",
      "2|1|2|x",
      "1|9|5|x",
      "1|a|2|x",
      "1|1|2",
      '{"a":1}',
      "1|-1|2|x",
      "x1|1|2|x",
    ]) {
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
    // And again, cooldown after cooldown, for as long as the probes fail.
    expect(breaker.record(2_000, true)).toBe(true);
    expect(breaker.allow(2_999)).toBe(false);
    expect(breaker.record(3_000, false)).toBe(false);
    expect(breaker.record(3_000, true)).toBe(false); // a success starts the count over
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

  it("reports an invalidation L2 did not get, after the local part is done", async () => {
    await testCase(
      "NB-1233",
      "tier cache: a failed remote invalidation is reported, L1 is dropped",
    );
    const server = new FakeServer();
    const { cache, source } = rig(server);
    source.rows.set("k", 1);
    await cache.get("k");

    server.failing = true;
    source.rows.set("k", 2);
    const failure = await cache.invalidate("k").catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2); // the tombstone and the publish
    expect(await cache.get("k")).toEqual({ key: "k", version: 2 }); // this process is consistent anyway
  });

  it("returns a value it cannot encode, without caching it", async () => {
    await testCase("NB-1234", "tier cache: a value that cannot be encoded is served, not cached");
    let loads = 0;
    const warn = vi.fn<(obj: Record<string, unknown>, msg: string) => void>();
    const cache = new TierCache<{ self?: unknown }>(
      { name: "cyclic", hardTtlMs: 10_000 },
      () => {
        loads += 1;
        const value: { self?: unknown } = {};
        value.self = value; // JSON cannot hold it
        return Promise.resolve(value);
      },
      undefined,
      { logger: { warn }, now: () => clock },
    );
    const capture = captureMetrics();
    const counted = new TierCache<number>(
      { name: "enc", hardTtlMs: 10_000 },
      () => Promise.resolve(1),
      undefined,
      {
        codec: {
          encode: () => {
            throw new Error("cannot encode");
          },
          decode: () => 1,
        },
      },
    );
    try {
      await counted.get("k");
      expect(
        metricValue(await capture.scrape(), "tiercache_reads_total", {
          cache: "enc",
          result: "load",
        }),
      ).toBe(1);
    } finally {
      await counted.close();
      await capture.stop();
    }

    expect((await cache.get("k"))?.self).toBeDefined();
    await cache.get("k");
    expect(loads).toBe(2);
    expect(warn).toHaveBeenCalledWith(
      expect.anything(),
      "tiercache: cannot encode the value for the cache",
    );
    await cache.close();
  });

  it("keeps trying to subscribe, and stops when closed", async () => {
    await testCase("NB-1235", "tier cache: a failed subscription is retried until close");
    let attempts = 0;
    const server = new FakeServer();
    const remote = server.remote();
    const warn = vi.fn<(obj: Record<string, unknown>, msg: string) => void>();
    const cache = new TierCache<number>(
      { name: "sub", hardTtlMs: 10_000 },
      () => Promise.resolve(1),
      {
        ...remote,
        subscribe: (...args) => {
          attempts += 1;
          return attempts === 1
            ? Promise.reject(new Error("no connection"))
            : remote.subscribe(...args);
        },
      },
      { logger: { warn } },
    );
    expect(await cache.get("k")).toBe(1); // reads do not wait for the subscription
    await vi.waitFor(
      () => {
        expect(server.subscribers.size).toBe(1);
      },
      { timeout: 3_000 },
    );
    expect(warn).toHaveBeenCalledWith(
      expect.anything(),
      "tiercache: invalidation subscription failed, retrying",
    );
    await cache.close();
    expect(server.subscribers.size).toBe(0);

    // Closed while waiting for the next attempt: close does not sit out the wait.
    const never = new TierCache<number>(
      { name: "sub2", hardTtlMs: 10_000 },
      () => Promise.resolve(1),
      {
        ...remote,
        subscribe: () => Promise.reject(new Error("no connection")),
      },
    );
    await settle();
    const started = performance.now();
    await never.close();
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("does not start a lookup for a caller that has already gone", async () => {
    await testCase("NB-1191", "tier cache: each caller honours its own signal");
    const { cache, source } = rig(undefined);
    source.rows.set("k", 1);
    await expect(cache.get("k", AbortSignal.abort(new Error("already gone")))).rejects.toThrow(
      "already gone",
    );
  });

  it("does not answer a read that follows an invalidation with a load that began before it", async () => {
    await testCase("NB-1342", "tier cache: a read after invalidate() never joins an older lookup");
    const gates: Array<() => void> = [];
    let version = 1;
    let loads = 0;
    const cache = new TierCache<number>(
      { name: "ryw", hardTtlMs: 10_000 },
      async () => {
        loads += 1;
        const seen = version; // what a query that began before the write sees
        await new Promise<void>((resolve) => {
          gates.push(resolve);
        });
        return seen;
      },
      undefined,
      { now: () => clock },
    );
    open.push(cache as never);

    const before = cache.get("k");
    await settle();
    version = 2;
    await cache.invalidate("k");
    const after = cache.get("k"); // must not be handed the row read before the write
    await settle();
    expect(loads).toBe(2);

    gates[0]?.(); // the older lookup ends first: it must not take the newer one with it
    expect(await before).toBe(1);
    const joined = cache.get("k");
    await settle();
    expect(loads).toBe(2);
    gates[1]?.();
    expect(await Promise.all([after, joined])).toEqual([2, 2]);
  });

  it("starts nothing for a caller that has already gone, whatever the source does", async () => {
    await testCase("NB-1191", "tier cache: each caller honours its own signal");
    const { cache, source } = rig(undefined);
    source.failing = true; // a lookup nobody waits for would end in an unhandled rejection
    await expect(cache.get("k", AbortSignal.abort(new Error("already gone")))).rejects.toThrow(
      "already gone",
    );
    await settle();
    expect(source.loads).toBe(0);
  });

  it("serves from L1 strictly before each deadline", async () => {
    await testCase("NB-1343", "tier cache: a deadline is the first moment a value is too old");
    const atSoft = rig(undefined);
    atSoft.source.rows.set("k", 1);
    await atSoft.cache.get("k");
    atSoft.advance(1_000); // exactly the soft deadline: stale already
    await atSoft.cache.get("k");
    await settle();
    expect(atSoft.source.loads).toBe(2);

    const atHard = rig(undefined);
    atHard.source.rows.set("k", 1);
    await atHard.cache.get("k");
    atHard.source.rows.set("k", 2);
    atHard.advance(10_000); // exactly the hard deadline: not served any more
    expect(await atHard.cache.get("k")).toEqual({ key: "k", version: 2 });
  });

  it("takes from L2 strictly before each deadline", async () => {
    await testCase("NB-1343", "tier cache: a deadline is the first moment a value is too old");
    const server = new FakeServer();
    const writer = rig(server);
    writer.source.rows.set("k", 1);
    await writer.cache.get("k");

    // Stale in L2 is still an answer for a read: no load.
    writer.advance(1_500);
    const stale = rig(server);
    stale.source.rows.set("k", 2);
    expect(await stale.cache.get("k")).toEqual({ key: "k", version: 1 });
    expect(stale.source.loads).toBe(0);

    // Exactly at the hard deadline it is not: the source answers.
    writer.advance(8_500);
    const late = rig(server);
    late.source.rows.set("k", 2);
    expect(await late.cache.get("k")).toEqual({ key: "k", version: 2 });
    expect(late.source.loads).toBe(1);
  });

  it("a refresh takes a value somebody else has refreshed, while it is fresh", async () => {
    await testCase("NB-1344", "tier cache: a refresh reuses a fresh L2 value, never a stale one");
    const server = new FakeServer();
    const first = rig(server);
    const second = rig(server);
    const third = rig(server);
    for (const r of [first, second, third]) r.source.rows.set("k", 1);
    for (const r of [first, second, third]) await r.cache.get("k");
    expect([second.source.loads, third.source.loads]).toEqual([0, 0]);

    for (const r of [first, second, third]) r.source.rows.set("k", 2);
    first.advance(1_500);
    await first.cache.get("k");
    await settle(); // the first process has refreshed L2: fresh for 1000 ms from now

    await second.cache.get("k"); // stale in its L1: refreshed from L2, not from the source
    await settle();
    expect(second.source.loads).toBe(0);
    expect(await second.cache.get("k")).toEqual({ key: "k", version: 2 });

    first.advance(1_000); // exactly the soft deadline of what L2 holds: not fresh
    await third.cache.get("k");
    await settle();
    expect(third.source.loads).toBe(1);
  });

  it("serves an expired value strictly within the grace", async () => {
    await testCase(
      "NB-1178",
      "tier cache: stale-if-error serves an expired value for its grace only",
    );
    const local = rig(undefined, { staleIfErrorMs: 5_000 });
    local.source.rows.set("k", 1);
    await local.cache.get("k");
    local.source.failing = true;
    local.advance(14_999);
    expect(await local.cache.get("k")).toEqual({ key: "k", version: 1 });
    local.advance(1); // hard deadline + grace, to the millisecond
    await expect(local.cache.get("k")).rejects.toThrow("source is down");

    const server = new FakeServer();
    const writer = rig(server, { staleIfErrorMs: 5_000 });
    writer.source.rows.set("k", 1);
    await writer.cache.get("k");
    const shared = rig(server, { staleIfErrorMs: 5_000 });
    shared.source.failing = true;
    shared.advance(14_999);
    expect(await shared.cache.get("k")).toEqual({ key: "k", version: 1 });
    shared.advance(1);
    await expect(shared.cache.get("k")).rejects.toThrow("source is down");

    // Nothing to fall back to at all: the source's own error.
    await expect(shared.cache.get("never-loaded")).rejects.toThrow("source is down");
  });

  it("a failed refresh is a failed refresh even with the grace on", async () => {
    await testCase("NB-1190", "tier cache: a failed refresh keeps the stale value");
    const { cache, source, advance, warn } = rig(undefined, { staleIfErrorMs: 5_000 });
    source.rows.set("k", 1);
    await cache.get("k");
    source.failing = true;
    advance(1_500);
    await cache.get("k");
    await settle();
    expect(warn.mock.calls.map(([, msg]) => msg)).toEqual([
      "tiercache: background refresh failed, the stale value stays",
    ]);
  });

  it("refreshes a key again once the previous refresh is over", async () => {
    await testCase("NB-1189", "tier cache: background refreshes are bounded and one per key");
    // A limit of zero is no limit given: the default applies.
    const { cache, source, advance } = rig(undefined, { refreshConcurrency: 0 });
    source.rows.set("k", 1);
    await cache.get("k");
    for (const loads of [2, 3]) {
      advance(1_500);
      await cache.get("k");
      await settle();
      expect(source.loads).toBe(loads);
    }
  });

  it("writes to L2 with both deadlines, for the hard TTL and the grace", async () => {
    await testCase("NB-1345", "tier cache: L2 gets setNX for a new key, replace for a refresh");
    const server = new FakeServer();
    const { cache, source, advance } = rig(server, { staleIfErrorMs: 5_000 });
    source.rows.set("k", 1);
    await cache.get("k");
    expect(server.ops).toEqual(["setNX tc:t:k 15000"]);
    expect(server.data.get("tc:t:k")).toBe(
      encodeEnvelope(clock + 1_000, clock + 10_000, '{"key":"k","version":1}'),
    );

    advance(1_500);
    await cache.get("k");
    await settle();
    expect(server.ops).toEqual(["setNX tc:t:k 15000", "replace tc:t:k 15000"]);

    // Not found with nothing in L2: there is nothing to tombstone.
    await cache.get("absent");
    expect(server.ops).toHaveLength(2);
  });

  it("invalidates on its own channel only", async () => {
    await testCase(
      "NB-1182",
      "tier cache: invalidate reaches L1 of every process and tombstones L2",
    );
    const server = new FakeServer();
    const tasks = rig(server, { name: "tasks" });
    const users = rig(server, { name: "users" });
    for (const r of [tasks, users]) r.source.rows.set("k", 1);
    await tasks.cache.get("k");
    await users.cache.get("k");

    await tasks.cache.invalidate("k");
    expect(server.ops.slice(-2)).toEqual(["tombstone tc:tasks:k 5000", "publish tc:tasks:inv k"]);
    await users.cache.get("k"); // another cache's key of the same name is untouched
    expect(users.source.loads).toBe(1);
  });

  it("does not publish when invalidation is disabled, and needs no L2 to invalidate", async () => {
    await testCase("NB-1184", "tier cache: a reconnected subscription empties L1");
    const server = new FakeServer();
    const quiet = rig(server, { disableInvalidation: true });
    await quiet.cache.invalidate("k");
    expect(server.ops).toEqual(["tombstone tc:t:k 5000"]);

    const alone = rig(undefined);
    for (let i = 0; i < 8; i += 1) alone.source.rows.set(`k${i}`, 1);
    await expect(alone.cache.invalidate("k0")).resolves.toBeUndefined();
    for (let i = 0; i < 8; i += 1) await alone.cache.get(`k${i}`);
    expect(alone.warn).not.toHaveBeenCalled(); // no L2 is not a failing L2
  });

  it("names the L2 call that did not answer", async () => {
    await testCase(
      "NB-1233",
      "tier cache: a failed remote invalidation is reported, L1 is dropped",
    );
    const server = new FakeServer();
    const { cache } = rig(server, { remoteTimeoutMs: 20 });
    server.hanging = true;
    const failure = (await cache.invalidate("k").catch((err: unknown) => err)) as AggregateError;
    expect(failure.message).toBe("tiercache: invalidate failed");
    expect(failure.errors.map((err: Error) => `${err.name}: ${err.message}`)).toEqual([
      "RemoteTimeoutError: tiercache: L2 did not answer within 20 ms",
      "RemoteTimeoutError: tiercache: L2 did not answer within 20 ms",
    ]);
  });

  it("leaves no timer behind an L2 call that answered", async () => {
    await testCase("NB-1179", "tier cache: an unreachable L2 never fails a read");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { cache, source } = rig(new FakeServer());
      source.rows.set("k", 1);
      await cache.get("k");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops listening to a caller's signal once it has its answer", async () => {
    await testCase("NB-1191", "tier cache: each caller honours its own signal");
    const { cache, source } = rig(undefined);
    source.rows.set("k", 1);
    const caller = new AbortController();
    const removed = vi.spyOn(caller.signal, "removeEventListener");
    await cache.get("k", caller.signal);
    await settle();
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("does not keep a value that an invalidation and a reset both raced", async () => {
    await testCase("NB-1183", "tier cache: a load racing an invalidation is not cached anywhere");
    const server = new FakeServer();
    const { cache, source } = rig(server);
    source.rows.set("k", 1);
    let release!: () => void;
    source.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = cache.get("k");
    await settle();
    for (const s of server.subscribers) s.onMessage("other"); // somebody else's invalidation
    server.reconnect(); // and a reset
    release();
    await reading;
    source.gate = undefined;

    const calls = server.calls;
    await cache.get("k");
    expect(server.calls).toBe(calls + 1); // L1 did not keep it
  });

  it("does not let a read after a reset join a lookup that began before it", async () => {
    await testCase("NB-1342", "tier cache: a read after invalidate() never joins an older lookup");
    const server = new FakeServer();
    const { cache, source } = rig(server);
    source.rows.set("k", 1);
    let release!: () => void;
    source.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const before = cache.get("k");
    await settle();
    server.reconnect(); // invalidations may have been missed: whatever is in flight is suspect
    const after = cache.get("k");
    await settle();
    expect(source.loads).toBe(2);
    release();
    await Promise.all([before, after]);
  });

  it("accounts for every byte L1 holds", async () => {
    await testCase("NB-1187", "tier cache: L1 stays within its byte budget");
    const capture = captureMetrics();
    try {
      const size =
        1 + encodeEnvelope(clock + 1_000, clock + 10_000, '{"key":"a","version":1}').length;
      // Both limits are inclusive: an entry of exactly maxEntryBytes, two of exactly maxBytes.
      const { cache, source, advance } = rig(undefined, {
        name: "acc",
        maxEntryBytes: size,
        maxBytes: 2 * size,
      });
      const held = async (): Promise<number> =>
        metricValue(await capture.scrape(), "tiercache_l1_bytes", { cache: "acc" });
      for (const key of ["a", "b"]) source.rows.set(key, 1);
      await cache.get("a");
      await cache.get("b");
      await cache.get("a");
      await cache.get("b");
      expect(source.loads).toBe(2);
      expect(await held()).toBe(2 * size);

      advance(1_500); // a refresh replaces the entry: its bytes are not counted twice
      await cache.get("a");
      await settle();
      expect(source.loads).toBe(3);
      expect(await held()).toBe(2 * size);
      await cache.get("a");
      expect(source.loads).toBe(3); // and nothing was evicted to make room for a ghost

      await cache.invalidate("b");
      expect(await held()).toBe(size);
    } finally {
      await capture.stop();
    }
  });

  it("reports every outcome under its own label", async () => {
    await testCase(
      "NB-1346",
      "tier cache: every read, refresh and invalidation outcome is counted",
    );
    const capture = captureMetrics();
    try {
      const server = new FakeServer();
      const { cache, source, advance } = rig(server, {
        name: "m",
        staleIfErrorMs: 5_000,
        breakerThreshold: 1,
        refreshTimeoutMs: 20,
      });
      source.rows.set("k", 1);
      await cache.get("k"); // load
      await cache.get("k"); // fresh
      await cache.get("absent"); // not_found (and a local invalidation of the key)
      server.reconnect(); // a reset
      await cache.get("k"); // l2

      source.failing = true;
      advance(1_500);
      await cache.get("k"); // stale, and a refresh that fails
      await settle();
      advance(10_000);
      await cache.get("k"); // stale_error
      advance(5_000);
      await cache.get("k").catch(() => {}); // error

      server.failing = true;
      await cache.get("other").catch(() => {}); // opens the breaker
      await cache.get("other").catch(() => {}); // bypasses L2

      const text = await capture.scrape();
      const count = (name: string, labels: Record<string, string>): number =>
        metricValue(text, name, { cache: "m", ...labels });
      expect(
        ["fresh", "stale", "l2", "load", "stale_error", "not_found", "error"].map((result) =>
          count("tiercache_reads_total", { result }),
        ),
      ).toEqual([1, 1, 1, 1, 1, 1, 3]);
      expect(count("tiercache_refreshes_total", { result: "error" })).toBe(1);
      expect(count("tiercache_invalidations_total", { scope: "key" })).toBe(1);
      expect(count("tiercache_invalidations_total", { scope: "all" })).toBe(2); // subscribed, reconnected
      expect(count("tiercache_l2_bypassed_total", {})).toBe(1);
      expect(text).toContain("# UNIT tiercache_l1_bytes By");
    } finally {
      await capture.stop();
    }
  });

  it("takes its gauge callback back on close", async () => {
    await testCase("NB-1192", "tier cache: close stops the running refreshes");
    const addCallback = vi.fn<(callback: unknown) => void>();
    const removeCallback = vi.fn<(callback: unknown) => void>();
    const meter = {
      createCounter: () => ({ add: () => {} }),
      createObservableGauge: () => ({ addCallback, removeCallback }),
    } as unknown as Meter;
    const cache = new TierCache<number>(
      { name: "g", hardTtlMs: 1 },
      () => Promise.resolve(1),
      undefined,
      {
        meter,
      },
    );
    expect(removeCallback).not.toHaveBeenCalled();
    await cache.close();
    // A callback left behind keeps the closed cache, and everything it holds, alive.
    expect(removeCallback).toHaveBeenCalledWith(addCallback.mock.calls[0]?.[0]);
  });

  it("warns once a second, with the cause", async () => {
    await testCase("NB-1347", "tier cache: one warning a second per cache");
    let now = 1_500; // the very first second of the clock counts too
    const warn = vi.fn<(obj: Record<string, unknown>, msg: string) => void>();
    const failure: { cause: unknown } = { cause: new Error("cannot encode") };
    const cache = new TierCache<number>(
      { name: "noisy", hardTtlMs: 10_000 },
      () => Promise.resolve(1),
      undefined,
      {
        logger: { warn },
        now: () => now,
        codec: {
          encode: () => {
            throw failure.cause;
          },
          decode: () => 1,
        },
      },
    );
    open.push(cache as never);
    await cache.get("k");
    now = 1_999;
    await cache.get("k");
    expect(warn.mock.calls.map(([fields]) => fields)).toEqual([
      { "cache.name": "noisy", "error.message": "cannot encode" },
    ]);
    now = 2_000;
    failure.cause = "not an error";
    await cache.get("k");
    expect(warn.mock.calls.at(-1)?.[0]).toEqual({
      "cache.name": "noisy",
      "error.message": "unknown error",
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("close waits for the lookups in flight and forgets what L1 held", async () => {
    await testCase("NB-1192", "tier cache: close stops the running refreshes");
    let loads = 0;
    let wound = false;
    let reason: unknown;
    const cache = new TierCache<number>(
      { name: "closing2", hardTtlMs: 10_000 },
      (key, signal) => {
        loads += 1;
        if (key === "quick" || signal.aborted) return Promise.resolve(1);
        return new Promise<number>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reason = signal.reason;
            setTimeout(() => {
              wound = true; // a loader that takes a moment to wind down
              reject(signal.reason as Error);
            }, 30);
          });
        });
      },
      undefined,
      { now: () => clock },
    );
    await cache.get("quick");
    const pending = cache.get("slow").catch((err: unknown) => err);
    await settle();
    await cache.close();
    expect(wound).toBe(true);
    expect(((await pending) as Error).message).toBe("tiercache: closed");
    expect((reason as Error).message).toBe("tiercache: closed");

    await cache.get("quick");
    expect(loads).toBe(3); // nothing is served from a closed cache's L1
  });

  it("drops the previous version of a key whose value outgrew L1", async () => {
    await testCase("NB-1188", "tier cache: an oversize entry is served from L2 and counted");
    const size =
      1 + encodeEnvelope(clock + 1_000, clock + 10_000, '{"key":"k","version":1}').length;
    const { cache, source, advance } = rig(undefined, { maxEntryBytes: size });
    source.rows.set("k", 1);
    await cache.get("k");
    source.rows.set("k", 1_000_000); // the row grew: its entry no longer fits
    advance(1_500);
    await cache.get("k"); // stale: refreshed behind
    await settle();
    // The old version must not be served until its hard deadline in place of the one just loaded.
    expect(await cache.get("k")).toEqual({ key: "k", version: 1_000_000 });
  });

  it("does not trust a deadline no clock of its own could have set", async () => {
    await testCase("NB-1349", "tier cache: an entry from a clock ahead of this one is a miss");
    const payload = '{"key":"k","version":1}';
    const server = new FakeServer();

    // The furthest a hard deadline can be: the hard TTL and all of its jitter.
    server.data.set("tc:t:k", encodeEnvelope(clock + 1_000, clock + 11_000, payload));
    const within = rig(server);
    within.source.rows.set("k", 2);
    expect(await within.cache.get("k")).toEqual({ key: "k", version: 1 });
    expect(within.source.loads).toBe(0);

    // A millisecond further: written by a clock that runs ahead. The source answers and replaces it.
    const ahead = encodeEnvelope(clock + 1_000, clock + 11_001, payload);
    server.data.set("tc:t:k", ahead);
    const reader = rig(server);
    reader.source.rows.set("k", 2);
    expect(await reader.cache.get("k")).toEqual({ key: "k", version: 2 });
    expect(server.ops.at(-1)).toBe("replace tc:t:k 10000");
    expect(server.data.get("tc:t:k")).not.toBe(ahead);

    // Nor is it something to fall back to when the source fails.
    server.data.set("tc:t:k", encodeEnvelope(clock + 3_600_000, clock + 3_610_000, payload));
    const failing = rig(server, { staleIfErrorMs: 5_000 });
    failing.source.failing = true;
    await expect(failing.cache.get("k")).rejects.toThrow("source is down");
  });

  it("does not trust its own L1 after the clock was stepped back", async () => {
    await testCase("NB-1349", "tier cache: an entry from a clock ahead of this one is a miss");
    const { cache, source, advance } = rig(undefined, { staleIfErrorMs: 5_000 });
    source.rows.set("k", 1);
    await cache.get("k");
    try {
      advance(-3_600_000); // the entry now looks fresh for an hour
      source.rows.set("k", 2);
      expect(await cache.get("k")).toEqual({ key: "k", version: 2 });

      advance(-3_600_000);
      source.failing = true;
      await expect(cache.get("k")).rejects.toThrow("source is down");
    } finally {
      advance(7_200_000);
    }
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
