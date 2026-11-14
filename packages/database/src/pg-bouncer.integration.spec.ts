import { ConfigService } from "@nestjs/config";
import pg, { type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { integration, meta, type PgBouncer, startPgBouncer, testCase, unique } from "@base/testing";

import { pgPoolProvider } from "./pg-pool.provider.js";
import { PgUnitOfWork } from "./pg-unit-of-work.service.js";
import { afterCommit, currentTransaction } from "./transaction.storage.js";

/**
 * The database layer behind PgBouncer — what a deployment that puts a
 * connection pooler in front of Postgres can rely on, established against a
 * real one (transaction pooling, the mode that changes the rules):
 *
 *   works     queries with parameters (the driver uses unnamed statements),
 *             the unit of work with savepoints and afterCommit, timeouts set
 *             on the role; migrations (apps/migrate, its own suite);
 *   does not  a session `SET` — it stays on a server connection and reaches
 *             whoever is served by it next. That is why behind transaction
 *             pooling the timeouts belong on the role (ALTER ROLE … SET) with
 *             DATABASE_*_TIMEOUT_MS zeroed: the pool's own `SET` cannot be
 *             relied on there;
 *   the limit PgBouncer's pool_size is the real limit: a query that waits
 *             for a server connection fails at query_wait_timeout.
 *
 * The counterpart of golang-basics' libs/pgx/pgbouncer_test.go.
 */
const infra = integration("postgres");

/** The session timeouts off: behind transaction pooling they live on the role. */
const NO_SESSION_TIMEOUTS = {
  DATABASE_STATEMENT_TIMEOUT_MS: "0",
  DATABASE_LOCK_TIMEOUT_MS: "0",
  DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: "0",
};

describe.skipIf(infra.skip)("Postgres behind PgBouncer (integration)", () => {
  meta({
    epic: "nodejs-basics",
    feature: "database",
    owner: "@team-platform",
    tags: ["database", "pgbouncer", "integration"],
  });

  const table = unique("bnc");
  const guarded = unique("guarded");
  let direct: pg.Pool;
  let bouncer: PgBouncer;
  let app: { user: string; password: string };

  const pooled = (alias: Parameters<PgBouncer["url"]>[0], user?: string): Pool =>
    pgPoolProvider.useFactory(
      new ConfigService({ DATABASE_URL: bouncer.url(alias, user), ...NO_SESSION_TIMEOUTS }),
    ) as Pool;

  beforeAll(async () => {
    const url = new URL(infra.url("postgres"));
    app = { user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
    direct = new pg.Pool({ connectionString: infra.url("postgres"), max: 2 });
    await direct.query(`CREATE TABLE ${table} (id serial PRIMARY KEY, v text NOT NULL)`);
    // A role that carries its timeouts itself — the setup for transaction pooling.
    await direct.query(`CREATE ROLE ${guarded} LOGIN PASSWORD 'guarded'`);
    await direct.query(`ALTER ROLE ${guarded} SET statement_timeout = '700ms'`);
    bouncer = await startPgBouncer(infra.url("postgres"), {
      users: { [app.user]: app.password, [guarded]: "guarded" },
      queryWaitTimeoutSeconds: 2,
    });
  }, 180_000);

  afterAll(async () => {
    await bouncer?.stop();
    await direct.query(`DROP TABLE IF EXISTS ${table}`);
    await direct.query(`DROP ROLE IF EXISTS ${guarded}`);
    await direct.end();
  });

  it("transaction pooling: parameterised queries, the unit of work, savepoints and afterCommit work", async () => {
    await testCase("NB-1259", "PgBouncer: the application path through transaction pooling");
    const pool = pooled("tx");
    const uow = new PgUnitOfWork(pool);
    try {
      // The same parameterised statement many times over a pool of server
      // connections: nothing is prepared by name, so nothing can be missing.
      const results = await Promise.all(
        Array.from({ length: 40 }, (_, i) => pool.query<{ n: number }>("SELECT $1::int AS n", [i])),
      );
      expect(results.map((r) => r.rows[0]?.n)).toEqual(Array.from({ length: 40 }, (_, i) => i));

      const events: string[] = [];
      await uow.runInTransaction(async () => {
        const tx = currentTransaction<Pool>()!;
        await tx.query(`INSERT INTO ${table} (v) VALUES ($1)`, ["kept"]);
        await uow
          .runInTransaction(
            async () => {
              await tx.query(`INSERT INTO ${table} (v) VALUES ($1)`, ["undone"]);
              throw new Error("inner");
            },
            { savepoint: true },
          )
          .catch(() => {});
        await afterCommit(() => {
          events.push("committed");
        });
      });
      await expect(
        uow.runInTransaction(async () => {
          await currentTransaction<Pool>()!.query(`INSERT INTO ${table} (v) VALUES ('lost')`);
          throw new Error("outer");
        }),
      ).rejects.toThrow("outer");

      const { rows } = await direct.query<{ v: string }>(`SELECT v FROM ${table} ORDER BY id`);
      expect(rows.map((r) => r.v)).toEqual(["kept"]);
      expect(events).toEqual(["committed"]);
    } finally {
      await pool.end();
    }
  });

  it("transaction pooling: timeouts set on the role are in effect on every server connection", async () => {
    await testCase("NB-1260", "PgBouncer: session timeouts belong on the role");
    const pool = pooled("tx", guarded);
    try {
      const started = Date.now();
      const failures = await Promise.all(
        Array.from({ length: 4 }, () =>
          pool.query("SELECT pg_sleep(5)").then(
            () => "finished",
            (err: { code?: string }) => err.code,
          ),
        ),
      );
      expect(failures).toEqual(["57014", "57014", "57014", "57014"]); // query_canceled
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      await pool.end();
    }
  });

  it("transaction pooling: a session SET stays on the server connection and reaches the next client", async () => {
    await testCase("NB-1261", "PgBouncer: a session SET leaks between clients");
    const first = new pg.Client({ connectionString: bouncer.url("tx_one") });
    const second = new pg.Client({ connectionString: bouncer.url("tx_one") });
    await first.connect();
    await second.connect();
    try {
      await first.query("SET statement_timeout = 4321");
      // Another client, the same (only) server connection: it inherits the setting.
      const seen = await second.query<{ statement_timeout: string }>("SHOW statement_timeout");
      expect(seen.rows[0]?.statement_timeout).toBe("4321ms");
      // Inside a transaction SET LOCAL is safe: it ends with the transaction.
      await first.query("RESET statement_timeout");
      await first.query("BEGIN");
      await first.query("SET LOCAL statement_timeout = 1234");
      await first.query("COMMIT");
      const after = await second.query<{ statement_timeout: string }>("SHOW statement_timeout");
      expect(after.rows[0]?.statement_timeout).not.toBe("1234ms");
    } finally {
      await first.query("RESET statement_timeout").catch(() => {});
      await first.end();
      await second.end();
    }
  });

  it("session pooling: a session SET holds for the session and is gone for the next client", async () => {
    await testCase("NB-1262", "PgBouncer: session pooling keeps, then resets, session state");
    const first = new pg.Client({ connectionString: bouncer.url("sess_one") });
    await first.connect();
    await first.query("SET statement_timeout = 4321");
    const mine = await first.query<{ statement_timeout: string }>("SHOW statement_timeout");
    expect(mine.rows[0]?.statement_timeout).toBe("4321ms");
    await first.end();

    const second = new pg.Client({ connectionString: bouncer.url("sess_one") });
    await second.connect();
    try {
      const seen = await second.query<{ statement_timeout: string }>("SHOW statement_timeout");
      expect(seen.rows[0]?.statement_timeout).not.toBe("4321ms"); // server_reset_query
    } finally {
      await second.end();
    }
  });

  it("the pooler's pool is the real limit: a query waiting for a server connection fails at query_wait_timeout", async () => {
    await testCase("NB-1264", "PgBouncer: server pool exhausted");
    const holder = new pg.Client({ connectionString: bouncer.url("tx_one") });
    const waiter = new pg.Client({ connectionString: bouncer.url("tx_one") });
    // PgBouncer closes the waiter's connection with the error: the client
    // reports that as an "error" event too.
    waiter.on("error", () => {});
    await holder.connect();
    await waiter.connect();
    try {
      await holder.query("BEGIN"); // takes the only server connection
      await holder.query("SELECT 1");
      const started = Date.now();
      await expect(waiter.query("SELECT 1")).rejects.toThrow(/query_wait_timeout/u);
      const waited = Date.now() - started;
      expect(waited).toBeGreaterThanOrEqual(1500);
      expect(waited).toBeLessThan(10_000);
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end().catch(() => {});
      await waiter.end().catch(() => {});
    }
  });
});
