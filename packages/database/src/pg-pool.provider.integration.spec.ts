import { ConfigService } from "@nestjs/config";
import { afterAll, describe, expect, it } from "vitest";

import { integration, meta, testCase } from "@base/testing";

import { pgPoolProvider } from "./pg-pool.provider.js";

const infra = integration("postgres");

describe.skipIf(infra.skip)("pg pool (integration)", () => {
  meta({
    epic: "nodejs-basics",
    feature: "database",
    owner: "@team-platform",
    tags: ["database", "integration"],
  });

  const warnings: Error[] = [];
  const onWarning = (warning: Error): void => {
    warnings.push(warning);
  };
  process.on("warning", onWarning);
  afterAll(() => {
    process.off("warning", onWarning);
  });

  it("runs the session init before handing out a fresh connection, one query at a time", async () => {
    await testCase("NB-1067", "no pg 'client is already executing a query' deprecation");
    const pool = pgPoolProvider.useFactory(
      new ConfigService({
        DATABASE_URL: infra.url("postgres"),
        DATABASE_STATEMENT_TIMEOUT_MS: "12345",
        DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: "23456",
      }),
    ) as import("pg").Pool;
    try {
      // pool.query hands its query to a new client in the same tick the pool
      // connects it; pool.connect() is the path of a transaction.
      const { rows } = await pool.query<{ statement_timeout: string }>("SHOW statement_timeout");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const idle = await client.query<{ idle_in_transaction_session_timeout: string }>(
          "SHOW idle_in_transaction_session_timeout",
        );
        await client.query("COMMIT");
        expect([
          rows[0]?.statement_timeout,
          idle.rows[0]?.idle_in_transaction_session_timeout,
        ]).toEqual(["12345ms", "23456ms"]);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
    // Emitted on the next tick after the offending query.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(warnings.map((w) => `${w.name}: ${w.message}`)).toEqual([]);
  });

  it("hands out the connection when the server refuses the session init", async () => {
    await testCase("NB-1070", "a failing SET is logged, never a pod-wide outage");
    const pool = pgPoolProvider.useFactory(
      new ConfigService({
        DATABASE_URL: infra.url("postgres"),
        // Past Postgres' INT_MAX ms: the server rejects the SET.
        DATABASE_STATEMENT_TIMEOUT_MS: "3000000000",
      }),
    ) as import("pg").Pool;
    try {
      expect((await pool.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
    } finally {
      await pool.end();
    }
  });
});
