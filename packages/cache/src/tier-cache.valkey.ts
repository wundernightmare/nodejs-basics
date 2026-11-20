import { Cluster, type Redis as Valkey } from "iovalkey";

import { TOMBSTONE } from "./cache-aside.js";
import type { TierCacheLogger, TierRemote } from "./tier-cache.js";
import { compareAndSet, type CompareAndSetMode } from "./valkey-cas.js";

/**
 * {@link TierRemote} over a Valkey client. Commands go through the client it
 * is given (its commandTimeout, tracing and deadline guard apply); a
 * subscription gets a connection of its own, as the protocol requires.
 *
 * `replace` is an atomic compare-and-set: SET … IFEQ on Valkey 8.1+, or Lua
 * for older servers. A tombstone or a newer value makes the comparison fail.
 */
export class ValkeyRemote implements TierRemote {
  readonly #client: Valkey | Cluster;
  readonly #logger: TierCacheLogger | undefined;
  readonly #compareAndSet: CompareAndSetMode;

  constructor(
    client: Valkey | Cluster,
    options: { logger?: TierCacheLogger; compareAndSet?: CompareAndSetMode } = {},
  ) {
    this.#client = client;
    this.#logger = options.logger;
    this.#compareAndSet = options.compareAndSet ?? "ifeq";
  }

  async get(key: string): Promise<string | undefined> {
    const raw = await this.#client.get(key);
    return raw === null || raw === TOMBSTONE ? undefined : raw;
  }

  async setNX(key: string, value: string, ttlMs: number): Promise<boolean> {
    return (await this.#client.set(key, value, "PX", px(ttlMs), "NX")) === "OK";
  }

  async replace(key: string, old: string, value: string, ttlMs: number): Promise<boolean> {
    return compareAndSet(this.#client, this.#compareAndSet, key, old, value, ttlMs);
  }

  async tombstone(key: string, ttlMs: number): Promise<void> {
    await this.#client.set(key, TOMBSTONE, "PX", px(ttlMs));
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.#client.publish(channel, message);
  }

  /**
   * Pub/Sub is at most once and the connection reconnects on its own, so
   * messages published while it was down are lost without any error.
   * `onSubscribed` is the signal for that: it runs each time the server has
   * acknowledged the subscription, the first time included. Resolves once the
   * connection is being established; a server that is down at that moment is
   * retried by the client.
   */
  subscribe(
    channel: string,
    onMessage: (message: string) => void,
    onSubscribed: () => void,
  ): Promise<() => Promise<void>> {
    // Resubscribing by hand, on every "ready": the acknowledgement is the
    // point from which no message is missed, and autoResubscribe hides it.
    const overrides = {
      autoResubscribe: false,
      enableOfflineQueue: false,
      lazyConnect: false,
      maxRetriesPerRequest: null,
    };
    const connection =
      this.#client instanceof Cluster
        ? this.#client.duplicate(undefined, overrides)
        : this.#client.duplicate(overrides);
    connection.on("error", (err: Error) => {
      this.#logger?.warn(
        { "cache.channel": channel, "error.message": err.message },
        "Cache subscription connection error",
      );
    });
    connection.on("message", (from: string, message: string) => {
      if (from === channel) onMessage(message);
    });
    connection.on("ready", () => {
      connection.subscribe(channel).then(onSubscribed, () => {
        // Not acknowledged: start over, the next "ready" subscribes again.
        connection.disconnect(true);
      });
    });
    return Promise.resolve(async () => {
      connection.disconnect();
      await Promise.resolve();
    });
  }
}

function px(ttlMs: number): number {
  return Math.max(1, Math.ceil(ttlMs));
}
