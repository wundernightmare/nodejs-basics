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
 * - An advisory lock serialises concurrent runners (every replica's init
 *   container, a CI job and a laptop): the second one waits, then finds
 *   nothing to do. The lock is a transaction's (`pg_advisory_xact_lock`),
 *   taken in the transaction that applies a file and released by its COMMIT
 *   or ROLLBACK — so the runner works through a transaction-pooling
 *   PgBouncer, where a session lock is taken on one server connection and
 *   "released" on another, and then held by nobody until that connection
 *   closes. The applied set is re-read under the lock, file by file.
 *   A `no-transaction` file cannot hold a transaction lock while it runs; it
 *   takes the session lock, and so needs a direct connection (or a pooler in
 *   session mode) — the runner cannot tell, the deployment has to.
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
  const lock = (): Promise<unknown> =>
    client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [table]);

  /** The checksum an applied migration was recorded with, or undefined. */
  const appliedChecksum = async (version: string): Promise<string | undefined> => {
    const { rows } = await client.query<{ checksum: string }>(
      `SELECT checksum FROM ${table} WHERE version = $1`,
      [version],
    );
    return rows[0]?.checksum;
  };
  const record = (m: Migration): Promise<unknown> =>
    client.query(`INSERT INTO ${table} (version, name, checksum) VALUES ($1, $2, $3)`, [
      m.version,
      m.name,
      m.checksum,
    ]);
  const changed = (m: Migration): Error =>
    new Error(`migrate: ${m.version}_${m.name}.sql changed after it was applied`);

  // The bookkeeping table and the check of what is applied, under the lock:
  // two runners racing CREATE TABLE IF NOT EXISTS can both lose.
  await inTransaction(client, async () => {
    await lock();
    await client.query(`CREATE TABLE IF NOT EXISTS ${table} (
      version    TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ version: string; checksum: string }>(
      `SELECT version, checksum FROM ${table}`,
    );
    for (const { version, checksum } of rows) {
      const local = migrations.find((m) => m.version === version);
      if (local === undefined) throw new Error(`migrate: applied migration ${version} is missing`);
      if (local.checksum !== checksum) throw changed(local);
    }
  });

  /** Applies m unless it is recorded already (read under the caller's lock); true when it ran. */
  const applyPending = async (m: Migration): Promise<boolean> => {
    const checksum = await appliedChecksum(m.version);
    if (checksum !== undefined) {
      if (checksum !== m.checksum) throw changed(m);
      return false; // another runner applied it meanwhile
    }
    try {
      await client.query(m.sql);
    } catch (err) {
      throw new Error(
        `migrate: ${m.version}_${m.name}.sql failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    await record(m);
    return true;
  };

  const done: string[] = [];
  for (const m of migrations) {
    const started = Date.now();
    let applied = false;
    if (m.transactional) {
      await inTransaction(client, async () => {
        await lock();
        applied = await applyPending(m);
      });
    } else {
      await client.query("SELECT pg_advisory_lock(hashtext($1))", [table]);
      try {
        applied = await applyPending(m);
      } finally {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [table]);
      }
    }
    if (!applied) continue;
    options.onApply?.(m, Date.now() - started);
    done.push(m.version);
  }
  return done;
}

async function inTransaction(client: ClientBase, fn: () => Promise<void>): Promise<void> {
  await client.query("BEGIN");
  try {
    await fn();
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}
