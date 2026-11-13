import { ConfigService } from "@nestjs/config";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { integration, meta, proxied, testCase, unique } from "@base/testing";
import type { ServiceProxy } from "@base/testing";

import { pgPoolProvider } from "./pg-pool.provider.js";
import { PgUnitOfWork } from "./pg-unit-of-work.service.js";
import { currentTransaction } from "./transaction.storage.js";

/**
 * The pool and the unit of work against a Postgres that misbehaves: the path
 * to it goes through Toxiproxy, and each test breaks it in one way. What is
 * proven is what the service relies on during an incident — every wait is
 * bounded, a transaction that lost its connection is reported as failed and
 * wrote nothing, and the pool is usable again the moment the database is.
 */
const infra = integration("postgres", "toxiproxy");

async function timed<T>(run: () => Promise<T>): Promise<{ ms: number; outcome: T | Error }> {
  const started = Date.now();
  const outcome = await run().catch((err: unknown) => err as Error);
  return { ms: Date.now() - started, outcome };
}

function poolOf(url: string, extra: Record<string, string> = {}): Pool {
  return pgPoolProvider.useFactory(
    new ConfigService({
      DATABASE_URL: url,
      DATABASE_POOL_MAX: "4",
      DATABASE_CONNECT_TIMEOUT_MS: "500",
      // The client-side cap on one query: the bound when the network, not the server, is slow.
      DATABASE_QUERY_TIMEOUT_MS: "400",
      ...extra,
    }),
  ) as Pool;
}

describe.skipIf(infra.skip)("pg pool and unit of work under faults (chaos)", () => {
  meta({
    epic: "nodejs-basics",
    feature: "database",
    owner: "@team-platform",
    tags: ["database", "chaos", "integration"],
  });

  const table = unique("chaos");
  let db: ServiceProxy;
  /** Straight to the database: what really got written. */
  let direct: Pool;
  let pool: Pool;
  let uow: PgUnitOfWork;

  beforeAll(async () => {
    db = await proxied("postgres");
    direct = poolOf(infra.url("postgres"));
    await direct.query(`CREATE TABLE ${table} (id serial PRIMARY KEY, v text NOT NULL)`);
    // The pool the provider builds, as a service gets it: no error listeners
    // added here. A connection error nobody listens for is an uncaught
    // exception, and vitest fails the run on one — which is the assertion that
    // losing the database never takes the process down.
    pool = poolOf(db.url);
    uow = new PgUnitOfWork(pool);
  });

  afterEach(async () => {
    await db.reset();
  });

  afterAll(async () => {
    await pool.end();
    await direct.query(`DROP TABLE IF EXISTS ${table}`);
    await direct.end();
  });

  const written = async (v: string): Promise<number> => {
    const res = await direct.query(`SELECT 1 FROM ${table} WHERE v = $1`, [v]);
    return res.rowCount ?? 0;
  };

  const insert = async (v: string): Promise<void> => {
    await currentTransaction<Pool>()!.query(`INSERT INTO ${table} (v) VALUES ($1)`, [v]);
  };

  it("works through the proxy when the database is healthy", async () => {
    await testCase("NB-1157", "chaos baseline: the proxied database works");
    await uow.runInTransaction(() => insert("baseline"));
    expect(await written("baseline")).toBe(1);
  });

  it("a database that goes away mid-transaction: the unit fails, nothing is written, the connection is dropped", async () => {
    await testCase(
      "NB-1158",
      "connection lost inside a unit of work: rejected, not half-committed",
    );
    const { ms, outcome } = await timed(() =>
      uow.runInTransaction(async () => {
        await insert("lost");
        await db.down();
        await insert("never");
      }),
    );
    expect(outcome).toBeInstanceOf(Error);
    expect(ms).toBeLessThan(2_000);
    await db.up();
    expect([await written("lost"), await written("never")]).toEqual([0, 0]);
    // The broken connection did not go back into the pool.
    expect(pool.idleCount).toBe(0);
  });

  it("is usable again as soon as the database is back", async () => {
    await testCase("NB-1159", "the pool recovers after an outage without a restart");
    await db.down();
    const refused = await timed(() => pool.query("SELECT 1"));
    expect(refused.outcome).toBeInstanceOf(Error);
    expect(refused.ms).toBeLessThan(1_500);

    await db.up();
    await uow.runInTransaction(() => insert("after-outage"));
    expect(await written("after-outage")).toBe(1);
  });

  it("a database that stops answering does not hold the caller past the query timeout", async () => {
    await testCase("NB-1160", "a silent connection ends at DATABASE_QUERY_TIMEOUT_MS");
    await pool.query("SELECT 1"); // a connection that is already open
    await db.toxic("timeout", { timeout: 0 }); // data stops; nothing is closed
    const { ms, outcome } = await timed(() => pool.query("SELECT pg_sleep(0)"));
    expect(outcome).toBeInstanceOf(Error);
    expect(ms).toBeGreaterThanOrEqual(350);
    expect(ms).toBeLessThan(1_500);

    await db.reset();
    expect((await pool.query("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);
  });

  it("a slow network: a unit of work past the query timeout fails and leaves nothing behind", async () => {
    await testCase("NB-1161", "latency beyond the query timeout: the unit is rolled back");
    await db.latency(1_000);
    const { ms, outcome } = await timed(() => uow.runInTransaction(() => insert("slow")));
    expect(outcome).toBeInstanceOf(Error);
    expect(ms).toBeLessThan(3_000);
    await db.reset();
    // The server may still have been running the unit when the client gave up.
    await expect.poll(() => written("slow"), { timeout: 3_000 }).toBe(0);
  });

  it("a statement waiting for a lock gives up at lock_timeout with 55P03", async () => {
    await testCase(
      "NB-1162",
      "DATABASE_LOCK_TIMEOUT_MS: a lock wait fails fast instead of queueing",
    );
    const impatient = poolOf(infra.url("postgres"), {
      DATABASE_LOCK_TIMEOUT_MS: "200",
      DATABASE_QUERY_TIMEOUT_MS: "5000",
    });
    await direct.query(`INSERT INTO ${table} (v) VALUES ('locked')`);
    const holder = await direct.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT 1 FROM ${table} WHERE v = 'locked' FOR UPDATE`);
      const { ms, outcome } = await timed(() =>
        impatient.query(`UPDATE ${table} SET v = 'stolen' WHERE v = 'locked'`),
      );
      expect(outcome).toMatchObject({ code: "55P03" });
      expect(ms).toBeGreaterThanOrEqual(180);
      expect(ms).toBeLessThan(2_000);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await impatient.end();
    }
  });
});
