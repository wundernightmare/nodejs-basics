import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { integration, meta, testCase } from "@base/testing";

import { PgIdempotencyStore } from "./pg-idempotency.store.js";

/** The Postgres store keeps the Valkey store's semantics, TTL included. */
const infra = integration("postgres");
const key = (): string => `pg-store:${crypto.randomUUID()}`;

describe.skipIf(infra.skip)("PgIdempotencyStore (integration)", () => {
  meta({
    epic: "nodejs-basics",
    feature: "idempotency",
    owner: "@team-platform",
    tags: ["integration"],
  });

  const pool = new pg.Pool({ connectionString: infra.url("postgres") });
  const store = new PgIdempotencyStore(pool);

  afterAll(async () => {
    await pool.end();
  });

  it("setNx takes a free key once; set overwrites; del frees it", async () => {
    await testCase("NB-1006", "Postgres idempotency store ↔ the Valkey store's contract");
    const k = key();
    await expect(store.get(k)).resolves.toBeNull();
    await expect(store.setNx(k, "lock", 60)).resolves.toBe(true);
    await expect(store.setNx(k, "other", 60)).resolves.toBe(false);
    await store.set(k, "result", 60);
    await expect(store.get(k)).resolves.toBe("result");
    await store.del(k);
    await expect(store.get(k)).resolves.toBeNull();
    await expect(store.setNx(k, "again", 60)).resolves.toBe(true);
  });

  it("an expired key reads as absent and is taken by the next setNx", async () => {
    await testCase("NB-1007", "TTL: an expired lock or result never blocks the key");
    const k = key();
    await store.set(k, "old", 60);
    await pool.query(
      "UPDATE idempotency_keys SET expires_at = now() - interval '1 s' WHERE key = $1",
      [k],
    );
    await expect(store.get(k)).resolves.toBeNull();
    await expect(store.setNx(k, "new", 60)).resolves.toBe(true);
    await expect(store.get(k)).resolves.toBe("new");
  });
});
