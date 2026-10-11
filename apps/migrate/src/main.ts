/**
 * `migrate` — applies migrations/*.sql to DATABASE_URL and exits.
 *
 *   just migrate                                  # local, against `just deps`
 *   docker run --rm -e DATABASE_URL=… nodejs-basics-migrate:dev   # the image
 *   node dist/main.js --check-config | --config-reference | --help
 *
 * Run it before the new app version starts: a Kubernetes Job / init
 * container, a compose service the api depends on (docker/stack.yml), a CI
 * step. Exit 0 = the schema is current (also when nothing was pending),
 * 78 = a bad configuration, 1 = the migration failed.
 *
 * Configured like the apps (@base/config: env > config.yaml > registry
 * defaults, validated), with the DATABASE_* keys it understands:
 * DATABASE_URL, DATABASE_PASSWORD_FILE (a mounted Secret), DATABASE_SSL_MODE
 * and DATABASE_APPLICATION_NAME. Log lines carry the apps' envelope
 * (docs/log-envelope.schema.json) without bundling the logger.
 */
import { resolve } from "node:path";

import pg from "pg";

import { bootConfig } from "@base/config/boot";
import { envelopeLine } from "@base/config/loader";
import { ConfigValueError, processEnv, readSecretFile, readString } from "@base/config";
import { decorateConnectionString } from "@base/database/connection-string";

import { loadMigrations, migrate } from "./migrate.js";

function log(level: "info" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  (level === "error" ? process.stderr : process.stdout).write(envelopeLine(level, msg, fields));
}

async function main(): Promise<void> {
  bootConfig({
    name: "nodejs-basics-migrate",
    defaults: { OTEL_SERVICE_NAME: "nodejs-basics-migrate" },
    admin: false,
  });
  const appName = readString(processEnv, "DATABASE_APPLICATION_NAME") ?? "migrate";
  const url = decorateConnectionString(readString(processEnv, "DATABASE_URL"), {
    application_name: appName,
    sslmode: readString(processEnv, "DATABASE_SSL_MODE"),
    // A query parameter, not pg's `password` option: the connection string wins over that.
    password: readSecretFile(processEnv, "DATABASE_PASSWORD_FILE"),
  });
  // Next to dist/ in the repo, /migrations in the image (MIGRATIONS_DIR).
  const dir = resolve(
    process.env["MIGRATIONS_DIR"] ?? new URL("../../../migrations", import.meta.url).pathname,
  );
  const migrations = loadMigrations(dir);
  const client = new pg.Client({ connectionString: url, application_name: appName });
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
  // 78 (EX_CONFIG) like a bad value at boot: an unreadable DATABASE_PASSWORD_FILE.
  process.exitCode = err instanceof ConfigValueError ? 78 : 1;
});
