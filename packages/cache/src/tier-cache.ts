import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { metrics } from "@opentelemetry/api";
import type { Attributes, Counter, Meter, ObservableResult } from "@opentelemetry/api";

import { jitter } from "./cache-aside.js";

/**
 * A two-level read cache for values read far more often than they change: a
 * bounded L1 inside the process in front of a shared L2 (Valkey, through
 * {@link TierRemote}), in front of the source of truth (a loader). The
 * counterpart of golang-basics' libs/tiercache, with the same read rules.
 *
 *   const creds = new TierCache<Credential>(
 *     { name: "credentials:v1", softTtlMs: 30_000, hardTtlMs: 300_000 },
 *     (key, signal) => repo.findByKeyHash(key, signal),   // undefined: not found
 *     new ValkeyRemote(valkey),
 *     { logger },
 *   );
 *   const credential = await creds.get(keyOf(apiKey));
 *   // after the UPDATE / DELETE has committed:
 *   await afterCommit(() => creds.invalidate(keyOf(apiKey)));
 *   // on shutdown:
 *   await creds.close();
 *
 * Reading — both levels hold the value with two deadlines:
 *
 *   age < soft             served from L1                     (no I/O)
 *   soft ≤ age < hard      served from L1, refreshed behind   (stale-while-revalidate)
 *   hard ≤ age             ignored: L2, then the loader       (one lookup per key)
 *     … and the source fails   served for staleIfErrorMs more (off by default)
 *
 * soft == hard (the default) is plain cache-aside.
 *
 * Running without L2 — L1 is the always-on level. No remote, an unreachable
 * or a slow one never fails a read: every L2 call has its own deadline, a
 * breaker skips L2 after consecutive failures, and the loader answers instead.
 * What is lost is sharing between processes and invalidation, bounded by the
 * TTL.
 *
 * Invalidation — `invalidate()` drops the key from this process's L1,
 * tombstones it in L2 (which refuses the fills of readers that loaded the old
 * row) and publishes it, so every other process drops it from its L1. Pub/Sub
 * is at most once: each time the subscription is re-established L1 is emptied.
 * A lookup in flight when the key is invalidated still answers the callers it
 * already has, and nobody else: a read that follows `invalidate()` starts anew.
 *
 * Clocks — the deadlines are wall-clock instants, and an L2 entry is read by
 * processes other than the one that wrote it. A hard deadline further away
 * than this process could have set (hardTtlMs and its jitter, a tenth) came
 * from a clock that runs ahead, or from this one before it was stepped back:
 * such an entry is a miss in both levels, and the load replaces it. A clock
 * that runs behind only makes an entry expire sooner.
 *
 * Memory — L1 is bounded by `maxBytes` of encoded entries and evicts the
 * oldest first; nothing is evicted for age (an expired entry is ignored on
 * read and is what stale-if-error falls back to). Values are kept decoded and
 * handed to every reader as the same object: treat them as read-only.
 */
export interface TierCacheConfig {
  /**
   * Identifies the cache: the `cache` metric label, the L2 key prefix
   * ("tc:<name>:") and the invalidation channel ("tc:<name>:inv"). Put the
   * value's format version in it ("credentials:v1") so that a change of shape
   * starts from an empty keyspace.
   */
  name: string;
  /** L1 capacity in bytes of encoded entries. Default 32 MiB. */
  maxBytes?: number;
  /** Entries larger than this are not kept in L1 (served from L2, counted). Default 64 KiB. */
  maxEntryBytes?: number;
  /** Age past which a value is still served and refreshed behind. Default: hardTtlMs. */
  softTtlMs?: number;
  /** Age past which a value is never served (but see staleIfErrorMs). Required. */
  hardTtlMs: number;
  /** Grace past the hard deadline, used only when the source fails. Default 0: off. */
  staleIfErrorMs?: number;
  /** Deadline of one background refresh. Default 5 s. */
  refreshTimeoutMs?: number;
  /** Background refreshes in flight; a stale read past it is served without one. Default 16. */
  refreshConcurrency?: number;
  /** How long an invalidation refuses L2 fills: a few times the slowest load. Default 5 s. */
  tombstoneTtlMs?: number;
  /** Deadline of one L2 call. Default 250 ms. */
  remoteTimeoutMs?: number;
  /** Consecutive L2 failures that make reads skip it. Default 5. */
  breakerThreshold?: number;
  /** How long L2 is skipped then. Default 5 s. */
  breakerCooldownMs?: number;
  /** No Pub/Sub subscription: entries leave L1 by TTL only. Default false. */
  disableInvalidation?: boolean;
}

/** The second level: what the cache needs from a shared cache server. */
export interface TierRemote {
  /** The value at key; undefined when absent or tombstoned. */
  get(key: string): Promise<string | undefined>;
  /** Stores value only when key holds nothing (not even a tombstone). */
  setNX(key: string, value: string, ttlMs: number): Promise<boolean>;
  /** Stores value only when key still holds exactly `old`. */
  replace(key: string, old: string, value: string, ttlMs: number): Promise<boolean>;
  /** Makes key read as absent and refuse setNX / replace for ttlMs. */
  tombstone(key: string, ttlMs: number): Promise<void>;
  publish(channel: string, message: string): Promise<void>;
  /**
   * Delivers channel's messages until the returned function is called.
   * `onSubscribed` runs each time the subscription is (re-)established, the
   * first time included: messages published while it was down are lost.
   */
  subscribe(
    channel: string,
    onMessage: (message: string) => void,
    onSubscribed: () => void,
  ): Promise<() => Promise<void>>;
}

/** Turns a value into the text both levels store, and back. Default: JSON. */
export interface TierCodec<T> {
  encode(value: T): string;
  decode(text: string): T;
}

/**
 * Reads a value from the source of truth: undefined when there is none (not
 * cached), a throw when the source failed (what staleIfErrorMs is for).
 * `signal` aborts when the refresh deadline passes or the cache closes.
 */
export type TierLoader<T> = (key: string, signal: AbortSignal) => Promise<T | undefined>;

export interface TierCacheLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface TierCacheOptions<T> {
  codec?: TierCodec<T>;
  logger?: TierCacheLogger;
  /** Meter for the tiercache_* instruments. Default: the global one. */
  meter?: Meter;
  /** Wall clock in ms. Default: Date.now. */
  now?: () => number;
  /** Random source for the TTL jitter, in [0, 1). Default: Math.random. */
  random?: () => number;
}

/** A fixed-size key for a value identified by something secret or long (an API key). */
export function keyOf(text: string): string {
  return createHash("sha256").update(text).digest("base64url");
}

const ENVELOPE_VERSION = "1";

/**
 * What both levels store: "1|<soft ms>|<hard ms>|<payload>". Expiry travels
 * with the value, so an entry copied from L2 keeps its original deadlines.
 */
export function encodeEnvelope(softMs: number, hardMs: number, payload: string): string {
  return `${ENVELOPE_VERSION}|${softMs}|${hardMs}|${payload}`;
}

/**
 * Splits an envelope; undefined for anything this version did not write —
 * bytes from a cache are never trusted, the caller treats that as a miss.
 */
export function parseEnvelope(
  envelope: string,
): { softMs: number; hardMs: number; payload: string } | undefined {
  const match = /^1\|(\d{1,15})\|(\d{1,15})\|/u.exec(envelope);
  if (match === null) return undefined;
  const softMs = Number(match[1]);
  const hardMs = Number(match[2]);
  if (hardMs < softMs) return undefined;
  return { softMs, hardMs, payload: envelope.slice(match[0].length) };
}

/**
 * Keeps a failing L2 from costing every miss a full command timeout: after
 * `threshold` consecutive failures it is open for `cooldownMs` and L2 is
 * skipped; then calls are let through again and a single failure re-opens it.
 * Deliberately this small — L2 is optional, there is nothing to protect but
 * latency.
 */
export class RemoteBreaker {
  #failures = 0;
  #openUntil = 0;
  readonly #threshold: number;
  readonly #cooldownMs: number;

  constructor(threshold: number, cooldownMs: number) {
    this.#threshold = threshold;
    this.#cooldownMs = cooldownMs;
  }

  allow(now: number): boolean {
    return now >= this.#openUntil;
  }

  /** Takes the outcome of an L2 call; true when it opened the breaker. */
  record(now: number, failed: boolean): boolean {
    if (!failed) {
      this.#failures = 0;
      return false;
    }
    // Not reset on opening: the first failed probe after the cooldown opens it again.
    this.#failures += 1;
    if (this.#failures < this.#threshold) return false;
    this.#openUntil = now + this.#cooldownMs;
    return true;
  }
}

interface Entry<T> {
  softMs: number;
  hardMs: number;
  value: T;
  bytes: number;
}

interface Epoch {
  key: number;
  all: number;
}

type Source = "l2" | "load" | "stale_error" | "not_found";

interface Resolved<T> {
  value: T | undefined;
  source: Source;
}

type Settled<T> = Required<Omit<TierCacheConfig, "name">> & { name: string } & {
  codec: TierCodec<T>;
};

const MIB = 1024 * 1024;

function positive(value: number | undefined, fallback: number): number {
  const given = value ?? fallback;
  return given > 0 ? given : fallback;
}

function settle<T>(config: TierCacheConfig, codec: TierCodec<T> | undefined): Settled<T> {
  if (config.name === "") throw new Error("tiercache: name is required");
  if (!(config.hardTtlMs > 0)) throw new Error("tiercache: hardTtlMs must be positive");
  const softTtlMs = positive(config.softTtlMs, config.hardTtlMs);
  if (softTtlMs > config.hardTtlMs) {
    throw new Error(
      `tiercache: softTtlMs (${softTtlMs}) must not exceed hardTtlMs (${config.hardTtlMs})`,
    );
  }
  if ((config.staleIfErrorMs ?? 0) < 0) {
    throw new Error("tiercache: staleIfErrorMs must not be negative");
  }
  return {
    name: config.name,
    maxBytes: positive(config.maxBytes, 32 * MIB),
    maxEntryBytes: positive(config.maxEntryBytes, 64 * 1024),
    softTtlMs,
    hardTtlMs: config.hardTtlMs,
    staleIfErrorMs: config.staleIfErrorMs ?? 0,
    refreshTimeoutMs: positive(config.refreshTimeoutMs, 5_000),
    refreshConcurrency: positive(config.refreshConcurrency, 16),
    tombstoneTtlMs: positive(config.tombstoneTtlMs, 5_000),
    remoteTimeoutMs: positive(config.remoteTimeoutMs, 250),
    breakerThreshold: positive(config.breakerThreshold, 5),
    breakerCooldownMs: positive(config.breakerCooldownMs, 5_000),
    disableInvalidation: config.disableInvalidation ?? false,
    codec: codec ?? {
      encode: (value) => JSON.stringify(value),
      decode: (text) => JSON.parse(text) as T,
    },
  };
}

class RemoteTimeoutError extends Error {
  constructor(ms: number) {
    super(`tiercache: L2 did not answer within ${ms} ms`);
    this.name = "RemoteTimeoutError";
  }
}

/**
 * Rejects when `signal` aborts, without holding the promise it races. The
 * signal must not be aborted yet: the promise would be left without a handler.
 */
function abortable<V>(promise: Promise<V>, signal: AbortSignal | undefined): Promise<V> {
  if (signal === undefined) return promise;
  return new Promise<V>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason as Error);
    };
    // Stryker disable next-line ObjectLiteral,BooleanLiteral: the listener is removed below as well; `once` frees it when the promise never settles
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

export class TierCache<T> {
  readonly #cfg: Settled<T>;
  readonly #load: TierLoader<T>;
  readonly #remote: TierRemote | undefined;
  readonly #logger: TierCacheLogger | undefined;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #breaker: RemoteBreaker;
  readonly #prefix: string;
  /** The furthest ahead a hard deadline set by this process can be: hardTtlMs with all of its jitter. */
  readonly #longestMs: number;
  readonly #channel: string;

  readonly #local = new Map<string, Entry<T>>();
  #bytes = 0;
  /** A fill must not cross an invalidation of its key or a full reset. */
  readonly #epochs = new Map<string, number>();
  #resets = 0;

  /** The lookup a read of the key may join. An invalidation takes it out: see #forget. */
  readonly #flights = new Map<string, Promise<Resolved<T>>>();
  readonly #refreshing = new Map<string, Promise<void>>();
  readonly #life = new AbortController();
  #unsubscribe: (() => Promise<void>) | undefined;
  #subscription: Promise<void> | undefined;
  #lastWarnSecond = -1;

  readonly #reads: Counter;
  readonly #refreshes: Counter;
  readonly #invalidations: Counter;
  readonly #bypassed: Counter;
  readonly #oversize: Counter;
  readonly #labels: Attributes;
  readonly #disposeGauge: () => void;

  /** `remote` undefined: L1 and the loader only. The remote stays the caller's to close. */
  constructor(
    config: TierCacheConfig,
    load: TierLoader<T>,
    remote?: TierRemote,
    options: TierCacheOptions<T> = {},
  ) {
    this.#cfg = settle(config, options.codec);
    this.#load = load;
    this.#remote = remote;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#breaker = new RemoteBreaker(this.#cfg.breakerThreshold, this.#cfg.breakerCooldownMs);
    this.#prefix = `tc:${this.#cfg.name}:`;
    this.#longestMs = this.#cfg.hardTtlMs + Math.floor(this.#cfg.hardTtlMs / 10);
    this.#channel = `tc:${this.#cfg.name}:inv`;
    this.#labels = { cache: this.#cfg.name };

    // Stryker disable next-line StringLiteral: the meter's name is not exported
    const meter = options.meter ?? metrics.getMeter("tiercache");
    // Stryker disable StringLiteral,ObjectLiteral: names, descriptions and units are held to METRIC_REGISTRY by metrics.registry.spec.ts
    this.#reads = meter.createCounter("tiercache_reads_total", {
      description:
        "Reads by outcome: fresh or stale (served from L1), l2, load (source of truth), stale_error (expired value served because the source failed), not_found, error.",
    });
    this.#refreshes = meter.createCounter("tiercache_refreshes_total", {
      description:
        "Background refreshes of stale entries by outcome: ok, error, dropped (the refresh limit was reached).",
    });
    this.#invalidations = meter.createCounter("tiercache_invalidations_total", {
      description:
        "L1 invalidations by scope: key (one entry), all (a reset after the subscription was re-established).",
    });
    this.#bypassed = meter.createCounter("tiercache_l2_bypassed_total", {
      description: "Lookups that skipped L2 because its circuit breaker was open.",
    });
    this.#oversize = meter.createCounter("tiercache_l1_oversize_total", {
      description: "Entries not stored in L1 because they exceed its per-entry limit.",
    });
    const gauge = meter.createObservableGauge("tiercache_l1_bytes", {
      description: "Bytes of encoded entries L1 currently holds (bounded by its capacity).",
      unit: "By",
    });
    // Stryker restore StringLiteral,ObjectLiteral
    const observe = (result: ObservableResult): void => {
      result.observe(this.#bytes, this.#labels);
    };
    gauge.addCallback(observe);
    this.#disposeGauge = () => {
      gauge.removeCallback(observe);
    };

    if (remote !== undefined && !this.#cfg.disableInvalidation) {
      this.#subscription = this.#subscribe(remote);
    }
  }

  /**
   * The value for `key`, or undefined when the source of truth has none.
   * `signal` bounds this caller's wait only: concurrent callers for one key
   * share one lookup, and one impatient caller does not fail the others.
   *
   * An unreachable L2 never fails a read. When the loader fails too, a value
   * past its hard deadline is served for staleIfErrorMs more; beyond that the
   * loader's error is thrown.
   */
  async get(key: string, signal?: AbortSignal): Promise<T | undefined> {
    const entry = this.#local.get(key);
    if (entry !== undefined) {
      const now = this.#now();
      if (now < entry.hardMs && this.#trusted(entry.hardMs, now)) {
        if (now < entry.softMs) {
          this.#reads.add(1, { ...this.#labels, result: "fresh" });
        } else {
          this.#reads.add(1, { ...this.#labels, result: "stale" });
          this.#refresh(key);
        }
        return entry.value;
      }
    }

    try {
      // Before the lookup starts: one nobody waits for would fail unobserved.
      signal?.throwIfAborted();
      const resolved = await abortable(this.#flight(key, false, this.#life.signal), signal);
      this.#reads.add(1, { ...this.#labels, result: resolved.source });
      return resolved.value;
    } catch (err) {
      this.#reads.add(1, { ...this.#labels, result: "error" });
      throw err;
    }
  }

  /**
   * Drops `key` everywhere after a write to the source of truth has committed:
   * from this process's L1 at once, from L2 by a tombstone that also refuses
   * fills racing the write, and from every other process's L1 through the
   * invalidation channel.
   *
   * The local part cannot fail. A throw means L2 or the channel could not be
   * reached: other processes keep the old value until its TTL — log it.
   */
  async invalidate(key: string): Promise<void> {
    this.#invalidateLocal(key);
    const remote = this.#remote;
    if (remote === undefined) return;

    // The breaker is not consulted: an invalidation is worth one attempt even
    // while reads are skipping L2.
    const errors: unknown[] = [];
    try {
      await this.#remoteCall(() => remote.tombstone(this.#prefix + key, this.#cfg.tombstoneTtlMs));
    } catch (err) {
      errors.push(err);
    }
    if (!this.#cfg.disableInvalidation) {
      try {
        await this.#remoteCall(() => remote.publish(this.#channel, key));
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "tiercache: invalidate failed");
  }

  /**
   * Stops the subscription and the background refreshes, and waits for the
   * lookups in flight (one an invalidation has cut loose is aborted, not
   * waited for). The cache must not be used afterwards.
   */
  async close(): Promise<void> {
    this.#life.abort(new Error("tiercache: closed"));
    this.#disposeGauge();
    await this.#subscription;
    await this.#unsubscribe?.().catch(() => {});
    await Promise.allSettled([...this.#refreshing.values(), ...this.#flights.values()]);
    this.#local.clear();
    this.#bytes = 0;
  }

  /** The lookup of key in flight, started when there is none to join. */
  #flight(key: string, refreshing: boolean, signal: AbortSignal): Promise<Resolved<T>> {
    const joined = this.#flights.get(key);
    if (joined !== undefined) return joined;
    const flight = this.#resolve(key, refreshing, signal).finally(() => {
      // An invalidation may have put a newer lookup in its place.
      if (this.#flights.get(key) === flight) this.#flights.delete(key);
    });
    this.#flights.set(key, flight);
    return flight;
  }

  /** Reads an envelope from L2 into its deadlines and value; undefined for one that cannot be used. */
  #open(held: string): { softMs: number; hardMs: number; value: T; size: number } | undefined {
    const parsed = parseEnvelope(held);
    if (parsed === undefined) return undefined;
    const { softMs, hardMs, payload } = parsed;
    let value: T;
    try {
      value = this.#cfg.codec.decode(payload);
    } catch {
      return undefined; // corrupt payload: as good as absent
    }
    return { softMs, hardMs, value, size: Buffer.byteLength(held) };
  }

  /**
   * Looks key up in L2 and then in the source of truth, and fills the levels
   * above whatever answered. `refreshing` is the background variant: a stale
   * L2 value is not an answer for it (that is what it is replacing), and it
   * never falls back to an expired one.
   */
  async #resolve(key: string, refreshing: boolean, signal: AbortSignal): Promise<Resolved<T>> {
    const epoch = this.#epochOf(key);
    const remoteKey = this.#prefix + key;

    // What L2 holds now: the value a refresh replaces (compare-and-set), and
    // the fallback when the source fails.
    const held = await this.#remoteGet(remoteKey);
    // Stryker disable next-line ConditionalExpression: nothing parses as no envelope either
    const opened = held === undefined ? undefined : this.#open(held);

    const now = this.#now();
    // From a clock ahead of this one: as good as absent, and replaced by the load.
    const shared = opened !== undefined && this.#trusted(opened.hardMs, now) ? opened : undefined;
    if (shared !== undefined && now < shared.hardMs && (!refreshing || now < shared.softMs)) {
      this.#fill(epoch, key, shared.value, shared.softMs, shared.hardMs, shared.size);
      return { value: shared.value, source: "l2" };
    }

    let value: T | undefined;
    try {
      value = await this.#load(key, signal);
    } catch (err) {
      if (!refreshing) {
        const stale = this.#staleFallback(key, shared);
        if (stale !== undefined) {
          this.#warn("tiercache: source failed, serving an expired value", err);
          return { value: stale.value, source: "stale_error" };
        }
      }
      throw err;
    }

    if (value === undefined) {
      this.#drop(key);
      if (held !== undefined) {
        await this.#remoteCall(
          // Stryker disable next-line OptionalChaining: L2 held something, so there is an L2
          async () => this.#remote?.tombstone(remoteKey, this.#cfg.tombstoneTtlMs),
        ).catch(() => {});
      }
      return { value: undefined, source: "not_found" };
    }

    const hardTtl = jitter(this.#cfg.hardTtlMs, this.#random);
    const softTtl = Math.min(jitter(this.#cfg.softTtlMs, this.#random), hardTtl);
    const filledAt = this.#now();
    let envelope: string;
    try {
      envelope = encodeEnvelope(
        filledAt + softTtl,
        filledAt + hardTtl,
        this.#cfg.codec.encode(value),
      );
    } catch (err) {
      // The value is good, it just cannot be cached.
      this.#warn("tiercache: cannot encode the value for the cache", err);
      return { value, source: "load" };
    }

    // L2 decides whether this load may be cached at all: a tombstone, or a
    // value somebody else wrote meanwhile, refuses the write, and then L1 must
    // not keep it either. With L2 unreachable there is nobody to ask — and
    // nobody to learn of an invalidation from; L1 keeps it for its TTL.
    if (await this.#remoteStore(remoteKey, held, envelope, hardTtl + this.#cfg.staleIfErrorMs)) {
      this.#fill(
        epoch,
        key,
        value,
        filledAt + softTtl,
        filledAt + hardTtl,
        Buffer.byteLength(envelope),
      );
    }
    return { value, source: "load" };
  }

  /**
   * A value past its hard deadline but within staleIfErrorMs of it: the one
   * just read from L2, else the one L1 still holds.
   */
  #staleFallback(
    key: string,
    shared: { hardMs: number; value: T } | undefined,
  ): { value: T } | undefined {
    // With no grace the limit is now, and what got here is past its deadline.
    const now = this.#now();
    const limit = now - this.#cfg.staleIfErrorMs;
    if (shared !== undefined && shared.hardMs > limit) return shared;
    const entry = this.#local.get(key);
    return entry !== undefined && entry.hardMs > limit && this.#trusted(entry.hardMs, now)
      ? entry
      : undefined;
  }

  /**
   * Whether a hard deadline is one this process could have set at `now` or
   * earlier. Without it a writer whose clock runs ahead by an hour gives every
   * reader a value that stays fresh for an hour, whatever hardTtlMs says.
   */
  #trusted(hardMs: number, now: number): boolean {
    return hardMs - now <= this.#longestMs;
  }

  /**
   * Writes to L1 unless an invalidation arrived since `epoch`; evicts the
   * oldest entries. A value that outgrew L1 takes its previous version out:
   * that one must not be served in place of the one just read.
   */
  #fill(epoch: Epoch, key: string, value: T, softMs: number, hardMs: number, size: number): void {
    const bytes = Buffer.byteLength(key) + size;
    if (bytes > this.#cfg.maxEntryBytes) {
      this.#oversize.add(1, this.#labels);
      this.#drop(key);
      return;
    }
    const current = this.#epochOf(key);
    if (current.key !== epoch.key || current.all !== epoch.all) return;

    this.#drop(key);
    this.#local.set(key, { softMs, hardMs, value, bytes });
    this.#bytes += bytes;
    for (const [oldest, entry] of this.#local) {
      if (this.#bytes <= this.#cfg.maxBytes) break;
      this.#local.delete(oldest);
      this.#bytes -= entry.bytes;
    }
  }

  #epochOf(key: string): Epoch {
    return { key: this.#epochs.get(key) ?? 0, all: this.#resets };
  }

  #drop(key: string): void {
    const entry = this.#local.get(key);
    if (entry === undefined) return;
    this.#local.delete(key);
    this.#bytes -= entry.bytes;
  }

  #invalidateLocal(key: string): void {
    this.#epochs.set(key, (this.#epochs.get(key) ?? 0) + 1);
    this.#drop(key);
    // The lookup in flight may have read the old row: its callers keep it,
    // the next read starts its own.
    this.#flights.delete(key);
    this.#invalidations.add(1, { ...this.#labels, scope: "key" });
  }

  /** Empties L1: invalidations may have been missed. */
  #reset(): void {
    this.#resets += 1;
    this.#local.clear();
    this.#bytes = 0;
    this.#flights.clear();
    this.#invalidations.add(1, { ...this.#labels, scope: "all" });
  }

  /**
   * Starts the background refresh of a stale key unless one is already
   * running for it or the limit is reached. It is on the read path of every
   * stale hit, so the busy case costs a map lookup and nothing else.
   */
  #refresh(key: string): void {
    if (this.#refreshing.has(key) || this.#life.signal.aborted) return;
    if (this.#refreshing.size >= this.#cfg.refreshConcurrency) {
      this.#refreshes.add(1, { ...this.#labels, result: "dropped" });
      return;
    }
    const run = this.#runRefresh(key).finally(() => {
      this.#refreshing.delete(key);
    });
    this.#refreshing.set(key, run);
  }

  /** One background refresh: bounded by refreshTimeoutMs and by the cache's lifetime. */
  async #runRefresh(key: string): Promise<void> {
    const signal = AbortSignal.any([
      this.#life.signal,
      AbortSignal.timeout(this.#cfg.refreshTimeoutMs),
    ]);
    // The same flights as get(): a refresh and a synchronous lookup of one
    // key (past its hard deadline, say) are still a single load. The flight
    // may outlive its deadline (a loader that ignores the signal).
    try {
      await abortable(this.#flight(key, true, signal), signal);
      this.#refreshes.add(1, { ...this.#labels, result: "ok" });
    } catch (err) {
      this.#refreshes.add(1, { ...this.#labels, result: "error" });
      this.#warn("tiercache: background refresh failed, the stale value stays", err);
    }
  }

  /**
   * Applies the invalidations other processes publish. Pub/Sub is at most
   * once, so every (re-)established subscription empties L1: whatever was
   * published while it was down is unknown.
   */
  async #subscribe(remote: TierRemote): Promise<void> {
    const life = this.#life.signal;
    while (!life.aborted) {
      try {
        this.#unsubscribe = await remote.subscribe(
          this.#channel,
          (message) => {
            this.#invalidateLocal(message);
          },
          () => {
            this.#reset();
          },
        );
        return;
      } catch (err) {
        this.#warn("tiercache: invalidation subscription failed, retrying", err);
        await sleep(1_000, undefined, { signal: life }).catch(() => {});
      }
    }
  }

  /** One L2 call under its own deadline, its outcome fed to the breaker. */
  async #remoteCall<V>(call: () => Promise<V>): Promise<V> {
    const ms = this.#cfg.remoteTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    try {
      const value = await Promise.race([
        call(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new RemoteTimeoutError(ms));
          }, ms);
        }),
      ]);
      this.#breaker.record(this.#now(), false);
      return value;
    } catch (err) {
      if (this.#breaker.record(this.#now(), true)) {
        this.#warn("tiercache: L2 is failing, skipping it", err);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Reads L2 unless it is absent or its breaker is open; any failure is a miss. */
  async #remoteGet(remoteKey: string): Promise<string | undefined> {
    const remote = this.#remote;
    if (remote === undefined) return undefined;
    if (!this.#breaker.allow(this.#now())) {
      this.#bypassed.add(1, this.#labels);
      return undefined;
    }
    return this.#remoteCall(() => remote.get(remoteKey)).catch(() => undefined);
  }

  /**
   * Writes a loaded value to L2 — over the value the lookup started from when
   * there was one, into the empty key otherwise — and reports whether L1 may
   * keep it too: yes when L2 took it or could not be asked, no when it refused.
   */
  async #remoteStore(
    remoteKey: string,
    old: string | undefined,
    envelope: string,
    ttlMs: number,
  ): Promise<boolean> {
    const remote = this.#remote;
    if (remote === undefined || !this.#breaker.allow(this.#now())) return true;
    try {
      return await this.#remoteCall(() =>
        old === undefined
          ? remote.setNX(remoteKey, envelope, ttlMs)
          : remote.replace(remoteKey, old, envelope, ttlMs),
      );
    } catch {
      return true;
    }
  }

  /** At most one warning a second per cache: an outage must be seen, not turn every read into a log line. */
  #warn(msg: string, err: unknown): void {
    const second = Math.floor(this.#now() / 1_000);
    if (second === this.#lastWarnSecond) return;
    this.#lastWarnSecond = second;
    this.#logger?.warn(
      {
        "cache.name": this.#cfg.name,
        "error.message": err instanceof Error ? err.message : "unknown error",
      },
      msg,
    );
  }
}
