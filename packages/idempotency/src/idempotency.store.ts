/**
 * Storage abstraction for IdempotencyInterceptor.
 *
 * Implementations:
 *   - ValkeyIdempotencyStore (provided here) — Redis/Valkey-backed.
 *   - In-memory store for tests.
 *   - Anything else satisfying the interface.
 */
import type { Provider } from "@nestjs/common";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis as Valkey } from "iovalkey";

import { VALKEY_CLIENT } from "@base/cache";

export const IDEMPOTENCY_STORE = Symbol("IDEMPOTENCY_STORE");

export interface IdempotencyStore {
  /** Get the value for `key`, or null if absent. */
  get(key: string): Promise<string | null>;
  /** Set `key` → `value` with TTL in seconds. Overwrites any existing value. */
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /**
   * Atomic SET-IF-NOT-EXISTS with TTL. Returns true if the key was inserted,
   * false if it already existed.
   */
  setNx(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  /** Delete `key`. No-op if absent. */
  del(key: string): Promise<void>;
}

@Injectable()
export class ValkeyIdempotencyStore implements IdempotencyStore {
  constructor(@Inject(VALKEY_CLIENT) private readonly valkey: Valkey) {}

  async get(key: string): Promise<string | null> {
    return this.valkey.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.valkey.set(key, value, "EX", ttlSeconds);
  }

  async setNx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.valkey.set(key, value, "EX", ttlSeconds, "NX");
    return result !== null;
  }

  async del(key: string): Promise<void> {
    await this.valkey.del(key);
  }
}

export const valkeyIdempotencyStoreProvider: Provider = {
  provide: IDEMPOTENCY_STORE,
  useClass: ValkeyIdempotencyStore,
};
