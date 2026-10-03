/**
 * A forward-only SQL migration runner — the whole of it.
 *
 *   migrations/0001_init.sql
 *   migrations/0002_<next change>.sql
 *
 * - A file is `<4+ digit version>_<name>.sql`, applied in version order, each
 *   in its own transaction together with its row in `schema_migrations`.
 *   A file whose first line is `-- migrate: no-transaction` runs without one
 *   (CREATE INDEX CONCURRENTLY and friends).
 * - Applied migrations are immutable: the runner stores each file's sha256
 *   and refuses to run when an applied file changed or disappeared — fix
 *   forward with a new migration instead.
 * - A session advisory lock serialises concurrent runners (every replica's
 *   init container, a CI job and a laptop): the second one waits, then finds
 *   nothing to do.
 * - No down migrations: rolling a schema back is a new forward migration,
 *   written and reviewed like any other.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ClientBase } from "pg";

export interface Migration {
  version: string;
  name: string;
  sql: string;
  checksum: string;
  transactional: boolean;
}

export interface MigrateOptions {
  /** Bookkeeping table. Default `schema_migrations`. */
  table?: string;
  /** Progress callback, e.g. a logger. */
  onApply?: (m: Migration, ms: number) => void;
}

const FILE = /^(\d{4,})_([a-z0-9_]+)\.sql$/u;
const NO_TRANSACTION = /^--\s*migrate:\s*no-transaction\b/u;
const TABLE = /^[a-z_][a-z0-9_]*$/u;

/** Reads and validates the migration files of `dir`, in version order. */
export function loadMigrations(dir: string): Migration[] {
  const migrations: Migration[] = [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .toSorted();
  for (const file of files) {
    const match = FILE.exec(file);
    if (match === null) throw new Error(`migrate: "${file}" is not <version>_<name>.sql`);
    const [, version = "", name = ""] = match;
    if (migrations.some((m) => m.version === version)) {
      throw new Error(`migrate: two migrations share version ${version}`);
    }
    const sql = readFileSync(join(dir, file), "utf8");
    migrations.push({
      version,
      name,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
      transactional: !NO_TRANSACTION.test(sql),
    });
  }
  return migrations;
}

/** Applies the pending migrations; returns the versions it applied. */
export async function migrate(
  client: ClientBase,
  migrations: readonly Migration[],
  options: MigrateOptions = {},
): Promise<string[]> {
  const table = options.table ?? "schema_migrations";
  if (!TABLE.test(table)) throw new Error(`migrate: invalid table name "${table}"`);
  await client.query("SELECT pg_advisory_lock(hashtext($1))", [table]);
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS ${table} (
      version    TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ version: string; checksum: string }>(
      `SELECT version, checksum FROM ${table}`,
    );
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));
    for (const [version, checksum] of applied) {
      const local = migrations.find((m) => m.version === version);
      if (local === undefined) throw new Error(`migrate: applied migration ${version} is missing`);
      if (local.checksum !== checksum) {
        throw new Error(`migrate: ${version}_${local.name}.sql changed after it was applied`);
      }
    }

    const done: string[] = [];
    for (const m of migrations) {
      if (applied.has(m.version)) continue;
      const started = Date.now();
      const record = (): Promise<unknown> =>
        client.query(`INSERT INTO ${table} (version, name, checksum) VALUES ($1, $2, $3)`, [
          m.version,
          m.name,
          m.checksum,
        ]);
      if (m.transactional) {
        await client.query("BEGIN");
        try {
          await client.query(m.sql);
          await record();
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw new Error(`migrate: ${m.version}_${m.name}.sql failed: ${(err as Error).message}`, {
            cause: err,
          });
        }
      } else {
        await client.query(m.sql);
        await record();
      }
      options.onApply?.(m, Date.now() - started);
      done.push(m.version);
    }
    return done;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [table]);
  }
}
