import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { integration, meta, type PgBouncer, startPgBouncer, testCase, unique } from "@base/testing";

import { loadMigrations, migrate } from "./migrate.js";

/**
 * The runner through a transaction-pooling PgBouncer: every statement may
 * land on a different server connection, so a session advisory lock would be
 * taken on one and "released" on another — and stay held by nobody. The
 * runner's lock belongs to the transaction that applies a file.
 */
const infra = integration("postgres");

describe.skipIf(infra.skip)("migrate behind PgBouncer (integration)", () => {
  meta({
    epic: "nodejs-basics",
    feature: "database",
    owner: "@team-platform",
    tags: ["database", "migrations", "pgbouncer", "integration"],
  });

  const books = unique("mig");
  let direct: pg.Client;
  let bouncer: PgBouncer;
  let dir: string;

  beforeAll(async () => {
    const url = new URL(infra.url("postgres"));
    direct = new pg.Client({ connectionString: infra.url("postgres") });
    await direct.connect();
    bouncer = await startPgBouncer(infra.url("postgres"), {
      users: { [decodeURIComponent(url.username)]: decodeURIComponent(url.password) },
    });
    dir = mkdtempSync(join(tmpdir(), "migrations-bouncer-"));
  }, 180_000);

  afterAll(async () => {
    await bouncer?.stop();
    await direct.query(
      `DROP TABLE IF EXISTS ${books}, ${[1, 2, 3].map((i) => `${books}_t${i}`).join(", ")}`,
    );
    await direct.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("concurrent runners apply each file once, and nothing is left holding the lock", async () => {
    await testCase("NB-1263", "PgBouncer: migrations through transaction pooling");
    const runners = await Promise.all(
      [0, 1, 2].map(async () => {
        const runner = new pg.Client({ connectionString: bouncer.url("tx") });
        await runner.connect();
        return runner;
      }),
    );
    try {
      for (let i = 1; i <= 3; i += 1) {
        writeFileSync(
          join(dir, `000${i}_t${i}.sql`),
          `CREATE TABLE ${books}_t${i} (id int PRIMARY KEY); SELECT pg_sleep(0.05);`,
        );
      }
      const migrations = loadMigrations(dir);
      const applied = await Promise.all(
        runners.map((runner) => migrate(runner, migrations, { table: books })),
      );
      expect(applied.flat().toSorted()).toEqual(["0001", "0002", "0003"]);
      // A later runner gets through at once: no lock outlived its transaction.
      const started = Date.now();
      expect(await migrate(runners[0]!, migrations, { table: books })).toEqual([]);
      expect(Date.now() - started).toBeLessThan(2000);
      const { rows } = await direct.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'",
      );
      expect(rows[0]?.n).toBe(0);
    } finally {
      await Promise.all(runners.map((runner) => runner.end()));
    }
  });
});
