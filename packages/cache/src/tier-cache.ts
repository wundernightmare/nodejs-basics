import { createHash } from "node:crypto";

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
    this.#failures += 1;
    if (this.#failures < this.#threshold) return false;
    // One short of the threshold: the first failed probe after the cooldown opens it again.
    this.#failures = this.#threshold - 1;
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
  return value !== undefined && value > 0 ? value : fallback;
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

/** Rejects when `signal` aborts, without holding the promise it races. */
function abortable<V>(promise: Promise<V>, signal: AbortSignal | undefined): Promise<V> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<V>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason as Error);
    };
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
  readonly #channel: string;

  readonly #local = new Map<string, Entry<T>>();
  #bytes = 0;
  /**
   * Bumped by every invalidation. A fill checks that it has not moved since
   * its lookup began: a value read just before an invalidation must not be
   * written to L1 just after it and live there for a full TTL.
   */
  #epoch = 0;

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
    this.#channel = `tc:${this.#cfg.name}:inv`;
    this.#labels = { cache: this.#cfg.name };

    const meter = options.meter ?? metrics.getMeter("tiercache");
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
      if (now < entry.hardMs) {
        if (now < entry.softMs) {
          this.#reads.add(1, { ...this.#labels, result: "fresh" });
        } else {
          this.#reads.add(1, { ...this.#labels, result: "stale" });
          this.#refresh(key);
        }
        return entry.value;
      }
    }

    let flight = this.#flights.get(key);
    if (flight === undefined) {
      flight = this.#resolve(key, false, this.#life.signal).finally(() => {
        this.#flights.delete(key);
      });
      this.#flights.set(key, flight);
    }

    try {
      const resolved = await abortable(flight, signal);
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

  /** Stops the subscription and the background refreshes. The cache must not be used afterwards. */
  async close(): Promise<void> {
    this.#life.abort(new Error("tiercache: closed"));
    this.#disposeGauge();
    await this.#subscription;
    await this.#unsubscribe?.().catch(() => {});
    await Promise.allSettled([...this.#refreshing.values(), ...this.#flights.values()]);
    this.#local.clear();
    this.#bytes = 0;
  }

  /**
   * Looks key up in L2 and then in the source of truth, and fills the levels
   * above whatever answered. `refreshing` is the background variant: a stale
   * L2 value is not an answer for it (that is what it is replacing), and it
   * never falls back to an expired one.
   */
  async #resolve(key: string, refreshing: boolean, signal: AbortSignal): Promise<Resolved<T>> {
    const epoch = this.#epoch;
    const remoteKey = this.#prefix + key;

    // What L2 holds now: the value a refresh replaces (compare-and-set), and
    // the fallback when the source fails.
    const held = await this.#remoteGet(remoteKey);
    let parsed = held === undefined ? undefined : parseEnvelope(held);
    let heldValue: { value: T } | undefined;
    if (parsed !== undefined) {
      try {
        heldValue = { value: this.#cfg.codec.decode(parsed.payload) };
      } catch {
        parsed = undefined; // corrupt payload: as good as absent
      }
    }

    const now = this.#now();
    if (
      held !== undefined &&
      parsed !== undefined &&
      heldValue !== undefined &&
      now < parsed.hardMs &&
      (!refreshing || now < parsed.softMs)
    ) {
      this.#fill(epoch, key, heldValue.value, parsed.softMs, parsed.hardMs, held.length);
      return { value: heldValue.value, source: "l2" };
    }

    let value: T | undefined;
    try {
      value = await this.#load(key, signal);
    } catch (err) {
      if (!refreshing) {
        const stale = this.#staleFallback(key, parsed?.hardMs, heldValue);
        if (stale !== undefined) {
          this.#warn("tiercache: source failed, serving an expired value", err);
          return { value: stale.value, source: "stale_error" };
        }
      }
      throw err;
    }

    if (value === undefined) {
      // Gone from the source: stop serving what L1 and L2 still have.
      this.#invalidateLocal(key);
      if (held !== undefined && this.#remote !== undefined) {
        const remote = this.#remote;
        await this.#remoteCall(() => remote.tombstone(remoteKey, this.#cfg.tombstoneTtlMs)).catch(
          () => {},
        );
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
      this.#fill(epoch, key, value, filledAt + softTtl, filledAt + hardTtl, envelope.length);
    }
    return { value, source: "load" };
  }

  /**
   * A value past its hard deadline but within staleIfErrorMs of it: the one
   * just read from L2, else the one L1 still holds.
   */
  #staleFallback(
    key: string,
    heldHardMs: number | undefined,
    heldValue: { value: T } | undefined,
  ): { value: T } | undefined {
    if (this.#cfg.staleIfErrorMs <= 0) return undefined;
    const limit = this.#now() - this.#cfg.staleIfErrorMs;
    if (heldValue !== undefined && heldHardMs !== undefined && heldHardMs > limit) return heldValue;
    const entry = this.#local.get(key);
    return entry !== undefined && entry.hardMs > limit ? { value: entry.value } : undefined;
  }

  /** Writes to L1 unless an invalidation arrived since `epoch`; evicts the oldest entries. */
  #fill(epoch: number, key: string, value: T, softMs: number, hardMs: number, size: number): void {
    const bytes = key.length + size;
    if (bytes > this.#cfg.maxEntryBytes) {
      this.#oversize.add(1, this.#labels);
      return;
    }
    if (this.#epoch !== epoch) return;

    this.#drop(key);
    this.#local.set(key, { softMs, hardMs, value, bytes });
    this.#bytes += bytes;
    for (const [oldest, entry] of this.#local) {
      if (this.#bytes <= this.#cfg.maxBytes) break;
      this.#local.delete(oldest);
      this.#bytes -= entry.bytes;
    }
  }

  #drop(key: string): void {
    const entry = this.#local.get(key);
    if (entry === undefined) return;
    this.#local.delete(key);
    this.#bytes -= entry.bytes;
  }

  #invalidateLocal(key: string): void {
    this.#epoch += 1;
    this.#drop(key);
    this.#invalidations.add(1, { ...this.#labels, scope: "key" });
  }

  /** Empties L1: invalidations may have been missed. */
  #reset(): void {
    this.#epoch += 1;
    this.#local.clear();
    this.#bytes = 0;
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
    // key (after an invalidation, say) are still a single load.
    let flight = this.#flights.get(key);
    if (flight === undefined) {
      flight = this.#resolve(key, true, signal).finally(() => {
        this.#flights.delete(key);
      });
      this.#flights.set(key, flight);
    }
    try {
      await abortable(flight, signal);
      this.#refreshes.add(1, { ...this.#labels, result: "ok" });
    } catch (err) {
      // The flight may outlive its deadline (a loader that ignores the signal).
      flight.catch(() => {});
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
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, 1_000);
          function done(): void {
            clearTimeout(timer);
            life.removeEventListener("abort", done);
            resolve();
          }
          life.addEventListener("abort", done, { once: true });
        });
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
    try {
      return await this.#remoteCall(() => remote.get(remoteKey));
    } catch {
      return undefined;
    }
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
