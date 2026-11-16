/**
 * The memory of retroactive sampling: encoded spans in byte rings of a fixed
 * size.
 *
 * A shard is one ring of bytes, allocated once at its full size and never
 * grown. A span is appended as a record — a small header and the bytes of the
 * codec — and when the ring has no room the oldest records leave. Nothing
 * else is kept per span, so the size configured is the memory used, and it is
 * memory outside the JavaScript heap: the garbage collector never walks it.
 *
 * A trace lives in one shard (by a hash of its id, seeded per process — an id
 * that arrives over HTTP is the client's choice), so a trigger walks one ring
 * and not the whole buffer.
 *
 * The layout is the one of golang-basics' libs/otelx/retro and tracehub's
 * telemetry crate; the two rates (triggers of this process, triggers asked
 * for from outside) are the crate's.
 */
import { randomInt } from "node:crypto";

export const SHARDS_MAX = 64;
/** The least a shard holds, so a small buffer has fewer shards: a span is a few hundred bytes. */
export const SHARD_MIN_BYTES = 256 * 1024;
/**
 * How many triggered trace ids are remembered, so that the spans of a
 * triggered trace that end later are exported too. The oldest leaves first.
 */
export const TRIGGERED_MAX = 4096;

/** A record header: payload length, state, trace id, end time of the span (ms). */
export const HEADER_BYTES = 4 + 1 + 16 + 8;
const STATE_AT = 4;
const TRACE_AT = 5;
const END_AT = 21;
const LIVE = 0;
/**
 * The span was handed to a trigger; the record keeps its place until it
 * reaches the front, so a trigger never moves the ring.
 */
const TAKEN = 1;

/** What a trigger did. */
export type TriggerOutcome = "accepted" | "repeated" | "rate_limited";
/** Who asked: a log line of this process, or another service. */
export type TriggerSource = "local" | "remote";

export interface ArenaUsage {
  /** Spans kept. */
  spans: number;
  /** Bytes of the rings in use, headers and taken records included. */
  bytes: number;
  /** Seconds between the oldest and the newest span kept, in the shard where that is shortest. */
  horizonSeconds: number;
  kept: number;
  evicted: number;
  triggers: Record<TriggerSource, Record<TriggerOutcome, number>>;
}

class Shard {
  /** The ring: records, oldest first, from `head`, `size` bytes of them. */
  readonly buf: Buffer;
  head = 0;
  size = 0;
  /** Live records. */
  spans = 0;
  /** End time of the newest record ever pushed. */
  newestMs = 0;
  kept = 0;
  evicted = 0;
  readonly #header = Buffer.alloc(HEADER_BYTES);

  constructor(capacity: number) {
    // Not from the pool, and not zeroed: pages the ring has not reached yet
    // are not resident.
    this.buf = Buffer.allocUnsafeSlow(capacity);
  }

  /** Maps an offset from the oldest byte to an index of buf. */
  #at(offset: number): number {
    const i = this.head + offset;
    return i >= this.buf.length ? i - this.buf.length : i;
  }

  /** Copies dst.length bytes that start `offset` bytes after the oldest one. */
  #read(offset: number, dst: Buffer): void {
    const i = this.#at(offset);
    // copy() stops at the end of either buffer: what the first call could not
    // reach is at the start of the ring.
    const n = this.buf.copy(dst, 0, i);
    this.buf.copy(dst, n);
  }

  /** Writes src after the newest byte. The caller made the room. */
  #append(src: Buffer): void {
    const i = this.#at(this.size);
    const n = src.copy(this.buf, i);
    src.copy(this.buf, 0, n);
    this.size += src.length;
  }

  /**
   * Reads the header of the record `offset` bytes after the oldest byte into
   * the shard's scratch; the payload length, or -1 when no whole record is
   * there.
   */
  #headerAt(offset: number): number {
    // Past the newest record the bytes are whatever was there before: no
    // length read from them ends inside the ring.
    this.#read(offset, this.#header);
    const payload = this.#header.readUInt32LE(0);
    return offset + HEADER_BYTES + payload > this.size ? -1 : payload;
  }

  /** Drops the oldest record. The caller knows there is one. */
  #pop(): void {
    const payload = this.#headerAt(0);
    if (this.#header[STATE_AT] === LIVE) {
      this.spans -= 1;
      this.evicted += 1;
    }
    this.head = this.#at(HEADER_BYTES + payload);
    this.size -= HEADER_BYTES + payload;
  }

  /**
   * Appends a record — its header bytes are filled in here, the payload
   * follows them in `record` — evicting the oldest ones for it. A record
   * larger than the shard is not kept and counts as one evicted span.
   */
  push(traceId: string, endMs: number, record: Buffer): void {
    if (record.length > this.buf.length) {
      this.evicted += 1;
      return;
    }
    while (this.size + record.length > this.buf.length) this.#pop();
    record.writeUInt32LE(record.length - HEADER_BYTES, 0);
    record[STATE_AT] = LIVE;
    record.write(traceId, TRACE_AT, 16, "hex");
    record.writeDoubleLE(endMs, END_AT);
    this.#append(record);
    this.spans += 1;
    this.kept += 1;
    this.newestMs = Math.max(this.newestMs, endMs);
  }

  /**
   * Hands out copies of the payloads of the live records of the trace,
   * oldest first, and marks those records taken.
   */
  take(traceId: Buffer): Buffer[] {
    const out: Buffer[] = [];
    for (let offset = 0; ;) {
      const payload = this.#headerAt(offset);
      if (payload < 0) break;
      if (
        this.#header[STATE_AT] === LIVE &&
        traceId.compare(this.#header, TRACE_AT, TRACE_AT + 16) === 0
      ) {
        const copy = Buffer.allocUnsafe(payload);
        this.#read(offset + HEADER_BYTES, copy);
        out.push(copy);
        this.buf[this.#at(offset + STATE_AT)] = TAKEN;
        this.spans -= 1;
      }
      offset += HEADER_BYTES + payload;
    }
    // Taken records at the front free their room now.
    while (this.#headerAt(0) >= 0 && this.#header[STATE_AT] === TAKEN) this.#pop();
    return out;
  }

  /** Milliseconds between the oldest and the newest span kept. */
  horizonMs(): number {
    for (let offset = 0; ;) {
      const payload = this.#headerAt(offset);
      // Stryker disable next-line ConditionalExpression,EqualityOperator: asked only of a shard that holds a live span, which the walk reaches first
      if (payload < 0) return 0;
      if (this.#header[STATE_AT] === LIVE) {
        return Math.max(this.newestMs - this.#header.readDoubleLE(END_AT), 0);
      }
      offset += HEADER_BYTES + payload;
    }
  }
}

/** Admits at most `perSecond` in any second that starts with an admitted one. */
class Rate {
  #began = Number.NEGATIVE_INFINITY;
  #count = 0;

  constructor(private readonly perSecond: number) {}

  admit(nowMs: number): boolean {
    if (this.perSecond <= 0) return false;
    // A clock that stepped back opens a new window too: it must not close
    // the limit for as long as the step was.
    if (nowMs >= this.#began + 1_000 || nowMs < this.#began) {
      this.#began = nowMs;
      this.#count = 1;
      return true;
    }
    if (this.#count >= this.perSecond) return false;
    this.#count += 1;
    return true;
  }
}

export interface ArenaOptions {
  /** Bytes of all rings together. */
  capacityBytes: number;
  /** Traces a log line of this process may trigger a second. */
  triggersPerSecond: number;
  /** Traces triggered from outside a second; the local rate when not given. */
  remoteTriggersPerSecond?: number | undefined;
  /** Shards; by default as many as keep each at least SHARD_MIN_BYTES large. */
  shards?: number;
}

/** Byte rings in shards by trace id, and the traces that were triggered. */
export class Arena {
  readonly #shards: Shard[];
  readonly #seed = randomInt(0x1_0000_0000);
  /** Triggered trace ids, oldest first (a Set keeps insertion order). */
  readonly #triggered = new Set<string>();
  readonly #rates: Record<TriggerSource, Rate>;
  readonly #needle = Buffer.alloc(16);
  readonly #triggers: ArenaUsage["triggers"] = {
    local: { accepted: 0, repeated: 0, rate_limited: 0 },
    remote: { accepted: 0, repeated: 0, rate_limited: 0 },
  };
  /** The largest record a shard keeps: what the caller sizes its scratch by. */
  readonly recordMaxBytes: number;

  constructor(options: ArenaOptions) {
    const capacity = Math.max(Math.floor(options.capacityBytes), 0);
    const count = options.shards ?? shardCount(capacity);
    const each = Math.floor(capacity / count);
    this.#shards = Array.from({ length: count }, () => new Shard(each));
    this.recordMaxBytes = each;
    const local = new Rate(options.triggersPerSecond);
    this.#rates = {
      local,
      remote:
        options.remoteTriggersPerSecond === undefined
          ? local
          : new Rate(options.remoteTriggersPerSecond),
    };
  }

  #shard(traceId: string): Shard {
    // FNV-1a over the id, from a seed of this process.
    let hash = this.#seed;
    // Stryker disable next-line EqualityOperator: one more step changes every hash alike
    for (let i = 0; i < traceId.length; i++) {
      hash = Math.imul(hash ^ (traceId.codePointAt(i) ?? 0), 0x01000193);
    }
    // Not `this.#shards[...]!`: the index is always inside.
    return this.#shards[(hash >>> 0) % this.#shards.length] as Shard;
  }

  /** Whether the spans of the trace are exported. */
  isTriggered(traceId: string): boolean {
    return this.#triggered.has(traceId);
  }

  /**
   * Keeps a span: `record` is HEADER_BYTES of room followed by its encoded
   * bytes. The caller asked isTriggered() first.
   */
  offer(traceId: string, endMs: number, record: Buffer): void {
    this.#shard(traceId).push(traceId, endMs, record);
  }

  /** Counts a span that could not be offered as evicted. */
  refuse(traceId: string): void {
    this.#shard(traceId).evicted += 1;
  }

  /**
   * Triggers the trace at `nowMs`: the outcome and the encoded spans of it
   * the arena kept, oldest first.
   */
  trigger(
    traceId: string,
    source: TriggerSource,
    nowMs: number,
  ): { outcome: TriggerOutcome; payloads: Buffer[] } {
    const counted = this.#triggers[source];
    if (this.#triggered.has(traceId)) {
      counted.repeated += 1;
      return { outcome: "repeated", payloads: [] };
    }
    if (!this.#rates[source].admit(nowMs)) {
      counted.rate_limited += 1;
      return { outcome: "rate_limited", payloads: [] };
    }
    if (this.#triggered.size >= TRIGGERED_MAX) {
      for (const oldest of this.#triggered) {
        this.#triggered.delete(oldest);
        break;
      }
    }
    this.#triggered.add(traceId);
    counted.accepted += 1;
    this.#needle.write(traceId, 0, 16, "hex");
    return { outcome: "accepted", payloads: this.#shard(traceId).take(this.#needle) };
  }

  /** What the arena holds now. The horizon is the shortest among the shards that hold spans. */
  usage(): ArenaUsage {
    const out: ArenaUsage = {
      spans: 0,
      bytes: 0,
      horizonSeconds: 0,
      kept: 0,
      evicted: 0,
      triggers: { local: { ...this.#triggers.local }, remote: { ...this.#triggers.remote } },
    };
    let shortest = Number.POSITIVE_INFINITY;
    for (const shard of this.#shards) {
      out.spans += shard.spans;
      out.bytes += shard.size;
      out.kept += shard.kept;
      out.evicted += shard.evicted;
      if (shard.spans > 0) shortest = Math.min(shortest, shard.horizonMs());
    }
    if (out.spans > 0) out.horizonSeconds = shortest / 1_000;
    return out;
  }

  allocatedBytes(): number {
    return this.#shards.length * this.recordMaxBytes;
  }

  get shards(): number {
    return this.#shards.length;
  }
}

/** As many shards as keep each at least SHARD_MIN_BYTES large: a power of two, 1..SHARDS_MAX. */
export function shardCount(capacityBytes: number): number {
  const wanted = Math.min(Math.max(Math.floor(capacityBytes / SHARD_MIN_BYTES), 1), SHARDS_MAX);
  return 2 ** Math.floor(Math.log2(wanted));
}
