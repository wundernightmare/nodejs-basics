/**
 * `migrate` — applies migrations/*.sql to DATABASE_URL and exits.
 *
 *   just migrate                                  # local, against `just deps`
 *   docker run --rm -e DATABASE_URL=… nodejs-basics-migrate:dev   # the image
 *
 * Run it before the new app version starts: a Kubernetes Job / init
 * container, a compose service the api depends on (docker/stack.yml), a CI
 * step. Exit 0 = the schema is current (also when nothing was pending).
 * Logs are JSON lines, like the apps'.
 */
import { resolve } from "node:path";

import pg from "pg";

import { loadMigrations, migrate } from "./migrate.js";

function log(level: "info" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  const line = {
    "@timestamp": new Date().toISOString(),
    "log.level": level,
    message: msg,
    ...fields,
  };
  (level === "error" ? process.stderr : process.stdout).write(`${JSON.stringify(line)}\n`);
}

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"] ?? "postgresql://app:app@localhost:5432/app";
  // Next to dist/ in the repo, /migrations in the image (MIGRATIONS_DIR).
  const dir = resolve(
    process.env["MIGRATIONS_DIR"] ?? new URL("../../../migrations", import.meta.url).pathname,
  );
  const migrations = loadMigrations(dir);
  const client = new pg.Client({ connectionString: url, application_name: "migrate" });
  await client.connect();
  try {
    const applied = await migrate(client, migrations, {
      onApply: (m, ms) => {
        log("info", "migration applied", {
          "migration.version": m.version,
          "migration.name": m.name,
          "event.duration_ms": ms,
        });
      },
    });
    log("info", applied.length === 0 ? "schema is current" : "migrations applied", {
      "migration.applied": applied.length,
      "migration.latest": migrations.at(-1)?.version ?? null,
    });
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  log("error", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
