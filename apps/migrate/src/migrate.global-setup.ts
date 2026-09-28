/**
 * vitest globalSetup of the integration project: bring the test database to
 * the current schema before any suite runs — the same runner and the same
 * files the image applies, so a suite never tests a schema production does
 * not have. No DATABASE_URL (a laptop without `just deps`) → nothing to do;
 * the suites skip themselves.
 */
import { fileURLToPath } from "node:url";

import pg from "pg";

import { loadMigrations, migrate } from "./migrate.js";

export default async function setup(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (url === undefined || url === "") return;
  const client = new pg.Client({ connectionString: url, application_name: "migrate (vitest)" });
  await client.connect();
  try {
    await migrate(
      client,
      loadMigrations(fileURLToPath(new URL("../../../migrations", import.meta.url))),
    );
  } finally {
    await client.end();
  }
}
