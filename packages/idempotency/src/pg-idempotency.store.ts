/**
 * IdempotencyStore on Postgres — the substitute for ValkeyIdempotencyStore when
 * the api runs without Valkey (DISABLED_INTEGRATIONS=valkey): the same
 * semantics, shared by every replica, in the table of
 * migrations/0004_create_idempotency_keys.sql.
 */
import { Inject, Injectable, type Provider } from "@nestjs/common";
import type { Pool } from "pg";

import { PG_POOL } from "@base/database";

import { IDEMPOTENCY_STORE, type IdempotencyStore } from "./idempotency.store.js";

// Expired rows an insert deletes on its way — enough to keep up with the
// inserts, small enough to stay cheap.
const PRUNE_BATCH = 100;

@Injectable()
export class PgIdempotencyStore implements IdempotencyStore {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async get(key: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ value: string }>(
      "SELECT value FROM idempotency_keys WHERE key = $1 AND expires_at > now()",
      [key],
    );
    return rows[0]?.value ?? null;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO idempotency_keys (key, value, expires_at)
       VALUES ($1, $2, now() + make_interval(secs => $3))
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
      [key, value, ttlSeconds],
    );
  }

  async setNx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    // Inserted, or replaced an expired row: the key is ours. A live row: not.
    const { rowCount } = await this.pool.query(
      `WITH pruned AS (
         DELETE FROM idempotency_keys WHERE key IN (
           SELECT key FROM idempotency_keys WHERE expires_at <= now() AND key <> $1
           LIMIT ${PRUNE_BATCH} FOR UPDATE SKIP LOCKED))
       INSERT INTO idempotency_keys (key, value, expires_at)
       VALUES ($1, $2, now() + make_interval(secs => $3))
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
         WHERE idempotency_keys.expires_at <= now()`,
      [key, value, ttlSeconds],
    );
    return rowCount === 1;
  }

  async del(key: string): Promise<void> {
    await this.pool.query("DELETE FROM idempotency_keys WHERE key = $1", [key]);
  }
}

export const pgIdempotencyStoreProvider: Provider = {
  provide: IDEMPOTENCY_STORE,
  useClass: PgIdempotencyStore,
};
