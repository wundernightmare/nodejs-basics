import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { integration, meta, testCase, unique } from "@base/testing";

import { loadMigrations, migrate } from "./migrate.js";

/**
 * The runner against a real Postgres: its own bookkeeping table and its own
 * tables per run (unique names), so it never touches the schema the other
 * suites use.
 */
const infra = integration("postgres");

describe.skipIf(infra.skip)("migrate (integration)", () => {
  meta({
    epic: "nodejs-basics",
    feature: "database",
    owner: "@team-platform",
    tags: ["database", "migrations", "integration"],
  });

  const table = unique("mig");
  const books = `${table}_books`;
  let dir: string;
  let client: pg.Client;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "migrations-"));
    client = new pg.Client({ connectionString: infra.url("postgres") });
    await client.connect();
  });
  afterAll(async () => {
    await client.query(`DROP TABLE IF EXISTS ${table}, ${books}`);
    await client.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies pending files in order, once, and skips what is applied", async () => {
    await testCase("NB-221", "0001 + 0002 applied, a second run applies nothing");
    writeFileSync(join(dir, "0001_create.sql"), `CREATE TABLE ${books} (id int PRIMARY KEY);`);
    writeFileSync(
      join(dir, "0002_index.sql"),
      `-- migrate: no-transaction\nCREATE INDEX CONCURRENTLY ${books}_id ON ${books} (id);`,
    );
    const migrations = loadMigrations(dir);
    expect(migrations.map((m) => [m.version, m.transactional])).toEqual([
      ["0001", true],
      ["0002", false],
    ]);

    expect(await migrate(client, migrations, { table })).toEqual(["0001", "0002"]);
    expect(await migrate(client, migrations, { table })).toEqual([]);
    const { rows } = await client.query<{ version: string }>(
      `SELECT version FROM ${table} ORDER BY 1`,
    );
    expect(rows.map((r) => r.version)).toEqual(["0001", "0002"]);
  });

  it("rolls a failing migration back, and refuses an edited applied one", async () => {
    await testCase("NB-222", "a broken file leaves no trace; a changed file stops the run");
    writeFileSync(join(dir, "0003_broken.sql"), `INSERT INTO ${books} VALUES (1); SELECT nope;`);
    await expect(migrate(client, loadMigrations(dir), { table })).rejects.toThrow(
      /0003_broken\.sql failed/u,
    );
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${books}`);
    expect(rows[0]).toEqual({ n: 0 });
    rmSync(join(dir, "0003_broken.sql"));

    appendFileSync(join(dir, "0001_create.sql"), "\n-- edited");
    await expect(migrate(client, loadMigrations(dir), { table })).rejects.toThrow(
      /0001_create\.sql changed after it was applied/u,
    );
  });

  it("rejects file names and duplicate versions it cannot order", async () => {
    await testCase("NB-223", "only <version>_<name>.sql, one file per version");
    const bad = mkdtempSync(join(tmpdir(), "migrations-bad-"));
    try {
      writeFileSync(join(bad, "create.sql"), "SELECT 1;");
      expect(() => loadMigrations(bad)).toThrow(/is not <version>_<name>\.sql/u);
      rmSync(join(bad, "create.sql"));
      writeFileSync(join(bad, "0001_a.sql"), "SELECT 1;");
      writeFileSync(join(bad, "0001_b.sql"), "SELECT 1;");
      expect(() => loadMigrations(bad)).toThrow(/share version 0001/u);
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }
  });
});
