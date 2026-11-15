import { describe, expect, it } from "vitest";

import { testCase } from "@base/testing";

import { Arena, HEADER_BYTES, shardCount, SHARD_MIN_BYTES, TRIGGERED_MAX } from "./arena.js";

const id = (n: number): string => n.toString(16).padStart(32, "0");

/** A record of `payload` with the header's room in front, as the processor builds it. */
function record(payload: string): Buffer {
  const out = Buffer.alloc(HEADER_BYTES + Buffer.byteLength(payload));
  out.write(payload, HEADER_BYTES);
  return out;
}

function arena(capacityBytes: number, perSecond = 1_000, remote?: number): Arena {
  return new Arena({
    capacityBytes,
    triggersPerSecond: perSecond,
    remoteTriggersPerSecond: remote,
    shards: 1,
  });
}

const taken = (a: Arena, trace: number, nowMs = 0): string[] =>
  a.trigger(id(trace), "local", nowMs).payloads.map((p) => p.toString());

describe("retroactive sampling arena", () => {
  it("hands a triggered trace its spans, oldest first, and nobody else's", async () => {
    await testCase("NB-1350", "Retro buffer: a trigger takes the spans of its trace");
    const a = arena(4096);
    a.offer(id(1), 10, record("a1"));
    a.offer(id(2), 11, record("b1"));
    a.offer(id(1), 12, record("a2"));
    expect(a.usage()).toMatchObject({ spans: 3, kept: 3, evicted: 0 });

    expect(taken(a, 1)).toEqual(["a1", "a2"]);
    expect(a.isTriggered(id(1))).toBe(true);
    expect(a.isTriggered(id(2))).toBe(false);
    // Taken once: a second trigger of the same trace has nothing to add.
    expect(a.trigger(id(1), "local", 0)).toEqual({ outcome: "repeated", payloads: [] });
    expect(a.usage().spans).toBe(1);
    expect(taken(a, 2)).toEqual(["b1"]);
    expect(a.usage()).toMatchObject({ spans: 0, bytes: 0 });
  });

  it("never holds more than it was allocated: the oldest spans leave for the newest", async () => {
    await testCase("NB-1351", "Retro buffer: the memory is fixed, the oldest spans are evicted");
    const each = HEADER_BYTES + 10;
    const a = arena(each * 4 + 7); // four records and a remainder that fits none
    for (let i = 0; i < 11; i++) a.offer(id(i), i, record(`payload-${i}`.padEnd(10, ".")));
    const use = a.usage();
    expect(use).toMatchObject({ spans: 4, bytes: each * 4, kept: 11, evicted: 7 });
    expect(use.bytes).toBeLessThanOrEqual(a.allocatedBytes());
    // What is left is the newest four, intact though the ring wrapped twice.
    expect([6, 7, 8, 9, 10].map((i) => taken(a, i))).toEqual([
      [],
      ["payload-7."],
      ["payload-8."],
      ["payload-9."],
      ["payload-10"],
    ]);
  });

  it("keeps a record that wraps around the end of the ring whole", () => {
    const a = arena(100);
    // 29 + 20 = 49 bytes each: the third starts at 98 after the first left.
    for (let i = 0; i < 7; i++) {
      a.offer(id(i), i, record(String(i).repeat(20)));
      expect(taken(a, i)).toEqual([String(i).repeat(20)]);
    }
    expect(a.usage()).toMatchObject({ spans: 0, bytes: 0, evicted: 0 });
  });

  it("does not keep a span larger than a shard, and counts it as evicted", () => {
    const a = arena(64);
    a.offer(id(1), 1, record("x".repeat(64)));
    a.refuse(id(2));
    expect(a.usage()).toMatchObject({ spans: 0, bytes: 0, kept: 0, evicted: 2 });
  });

  it("frees a taken span in the middle only when it reaches the front", () => {
    const a = arena(4096);
    a.offer(id(1), 1, record("front"));
    a.offer(id(2), 2, record("middle"));
    a.offer(id(3), 3, record("back"));
    expect(taken(a, 2)).toEqual(["middle"]);
    // The record of trace 2 still holds its place behind the front one.
    const all = 3 * HEADER_BYTES + "frontmiddleback".length;
    expect(a.usage()).toMatchObject({ spans: 2, bytes: all });
    expect(taken(a, 1)).toEqual(["front"]);
    expect(a.usage()).toMatchObject({ spans: 1, bytes: HEADER_BYTES + 4 });
    // A taken record evicted later is not counted as a lost span.
    expect(a.usage().evicted).toBe(0);
  });

  it("reports how far back it reaches: between the oldest and the newest span kept", async () => {
    await testCase("NB-1352", "Retro buffer: the horizon is the age of the oldest span kept");
    const a = arena(4096);
    expect(a.usage().horizonSeconds).toBe(0);
    a.offer(id(1), 1_000, record("a"));
    a.offer(id(2), 3_500, record("b"));
    a.offer(id(3), 9_000, record("c"));
    expect(a.usage().horizonSeconds).toBe(8);
    taken(a, 1);
    expect(a.usage().horizonSeconds).toBe(5.5);
    // A span that ended earlier than the ones before it (a long parent's
    // child) does not make the horizon negative.
    const b = arena(4096);
    b.offer(id(1), 5_000, record("late"));
    b.offer(id(2), 1_000, record("early"));
    taken(b, 1);
    expect(b.usage().horizonSeconds).toBe(4);
  });

  it("triggers at most the configured traces a second, and a repeat costs nothing", async () => {
    await testCase("NB-1353", "Retro buffer: triggers are rate-limited per second");
    const a = arena(4096, 2);
    const outcome = (trace: number, at: number) => a.trigger(id(trace), "local", at).outcome;
    expect([outcome(1, 0), outcome(2, 10), outcome(3, 20)]).toEqual([
      "accepted",
      "accepted",
      "rate_limited",
    ]);
    // A refused trace is not remembered: it may be triggered later.
    expect(a.isTriggered(id(3))).toBe(false);
    expect(outcome(1, 30)).toBe("repeated");
    expect(outcome(3, 999)).toBe("rate_limited");
    expect(outcome(3, 1_000)).toBe("accepted");
    // A clock stepped back opens a window instead of closing the limit.
    expect([outcome(4, 500), outcome(5, 501), outcome(6, 502)]).toEqual([
      "accepted",
      "accepted",
      "rate_limited",
    ]);
    expect(a.usage().triggers.local).toEqual({ accepted: 5, repeated: 1, rate_limited: 3 });
    expect(arena(4096, 0).trigger(id(1), "local", 0).outcome).toBe("rate_limited");
  });

  it("gives the triggers from outside a rate of their own", async () => {
    await testCase("NB-1354", "Retro buffer: remote triggers do not spend the local rate");
    const a = arena(4096, 2, 1);
    const from = (source: "local" | "remote", trace: number) =>
      a.trigger(id(trace), source, 0).outcome;
    expect([from("remote", 1), from("remote", 2)]).toEqual(["accepted", "rate_limited"]);
    // A storm elsewhere did not spend the triggers of this process …
    expect([from("local", 3), from("local", 4), from("local", 5)]).toEqual([
      "accepted",
      "accepted",
      "rate_limited",
    ]);
    // … and a trace one side triggered is triggered for the other.
    expect([from("remote", 3), from("local", 1)]).toEqual(["repeated", "repeated"]);
    expect(a.usage().triggers).toEqual({
      local: { accepted: 2, repeated: 1, rate_limited: 1 },
      remote: { accepted: 1, repeated: 1, rate_limited: 1 },
    });
    // Without a rate of their own the remote ones share the local rate.
    const shared = arena(4096, 2);
    expect([
      shared.trigger(id(1), "remote", 0).outcome,
      shared.trigger(id(2), "local", 0).outcome,
      shared.trigger(id(3), "remote", 0).outcome,
    ]).toEqual(["accepted", "accepted", "rate_limited"]);
  });

  it("remembers a bounded number of triggered traces, forgetting the oldest", () => {
    const a = arena(4096, Number.MAX_SAFE_INTEGER);
    for (let i = 1; i <= TRIGGERED_MAX; i++) a.trigger(id(i), "local", 0);
    expect(a.isTriggered(id(1))).toBe(true);
    a.trigger(id(TRIGGERED_MAX + 1), "local", 0);
    expect(a.isTriggered(id(1))).toBe(false);
    expect(a.isTriggered(id(2))).toBe(true);
    expect(a.isTriggered(id(TRIGGERED_MAX + 1))).toBe(true);
  });

  it("splits the memory into shards a trigger walks one of", () => {
    expect(
      [0, 1, SHARD_MIN_BYTES, 3 * SHARD_MIN_BYTES, 16 << 20, 1 << 30].map((n) => shardCount(n)),
    ).toEqual([1, 1, 1, 2, 64, 64]);
    const a = new Arena({ capacityBytes: 4 * SHARD_MIN_BYTES + 3, triggersPerSecond: 1_000 });
    expect(a.shards).toBe(4);
    expect(a.recordMaxBytes).toBe(SHARD_MIN_BYTES);
    expect(a.allocatedBytes()).toBe(4 * SHARD_MIN_BYTES);
    // Every trace finds its own spans whichever shard it landed in.
    for (let i = 1; i <= 200; i++) {
      a.offer(id(i), i, record(`first-${i}`));
      a.offer(id(i), i, record(`second-${i}`));
    }
    expect(a.usage().spans).toBe(400);
    for (let i = 1; i <= 200; i++) {
      expect(taken(a, i)).toEqual([`first-${i}`, `second-${i}`]);
    }
    expect(a.usage()).toMatchObject({ spans: 0, bytes: 0 });
  });

  it("fills a ring to its last byte, and keeps a span exactly as large as the ring", () => {
    const each = HEADER_BYTES + 10;
    const a = arena(each * 4);
    for (let i = 0; i < 4; i++) a.offer(id(i), i, record(`payload-${i}.`));
    expect(a.usage()).toMatchObject({ spans: 4, bytes: each * 4, evicted: 0 });
    a.offer(id(4), 4, record("payload-4."));
    expect(a.usage()).toMatchObject({ spans: 4, bytes: each * 4, evicted: 1 });
    expect([0, 1, 4].map((i) => taken(a, i))).toEqual([[], ["payload-1."], ["payload-4."]]);

    const whole = arena(each);
    whole.offer(id(1), 1, record("0123456789"));
    expect(whole.usage()).toMatchObject({ spans: 1, kept: 1, evicted: 0 });
    expect(taken(whole, 1)).toEqual(["0123456789"]);
  });

  it("keeps a span with nothing in it like any other", () => {
    const a = arena(4096);
    a.offer(id(1), 1, record(""));
    a.offer(id(2), 2, record("after"));
    a.offer(id(1), 3, record(""));
    expect(a.usage()).toMatchObject({ spans: 3, bytes: 3 * HEADER_BYTES + 5 });
    expect(taken(a, 2)).toEqual(["after"]);
    expect(taken(a, 1)).toEqual(["", ""]);
    expect(a.usage()).toMatchObject({ spans: 0, bytes: 0 });
  });

  it("never hands out a span twice, even to a trace it forgot it had triggered", () => {
    const a = arena(4096, Number.MAX_SAFE_INTEGER);
    a.offer(id(1), 1, record("front, keeps the next one in place"));
    a.offer(id(2), 2, record("taken once"));
    expect(taken(a, 2)).toEqual(["taken once"]);
    for (let i = 10; i < 10 + TRIGGERED_MAX; i++) a.trigger(id(i), "local", 0);
    expect(a.isTriggered(id(2))).toBe(false);
    expect(a.trigger(id(2), "local", 0)).toEqual({ outcome: "accepted", payloads: [] });
    expect(a.usage().spans).toBe(1);
  });

  it("measures the horizon from the oldest span still kept, past the ones already taken", () => {
    const each = HEADER_BYTES + 4;
    const a = arena(each * 3);
    a.offer(id(1), 1_000, record("aaaa"));
    a.offer(id(2), 2_000, record("bbbb"));
    a.offer(id(3), 4_000, record("cccc"));
    taken(a, 2);
    // Evicting the first leaves the taken one at the front.
    a.offer(id(4), 9_000, record("dddd"));
    expect(a.usage()).toMatchObject({ spans: 2, evicted: 1, horizonSeconds: 5 });
    expect(taken(a, 3)).toEqual(["cccc"]);
    expect(a.usage()).toMatchObject({ spans: 1, horizonSeconds: 0, bytes: each });
  });

  it("spreads the traces over the shards, and reports the horizon of the ones that hold spans", () => {
    const a = new Arena({ capacityBytes: 4 * SHARD_MIN_BYTES, triggersPerSecond: 1 });
    // 600 KiB: more than two shards hold, far less than four do.
    const kib = "x".repeat(1024 - HEADER_BYTES);
    for (let i = 1; i <= 600; i++) a.offer(id(i * 7919), 1_000, record(kib));
    expect(a.usage()).toMatchObject({ spans: 600, evicted: 0, bytes: 600 * 1024 });

    const sparse = new Arena({ capacityBytes: 16 * SHARD_MIN_BYTES, triggersPerSecond: 1 });
    sparse.offer(id(1), 1_000, record("first"));
    sparse.offer(id(1), 3_500, record("second"));
    // Fifteen shards are empty: they have no horizon to be the shortest.
    expect(sparse.usage().horizonSeconds).toBe(2.5);
  });
});
