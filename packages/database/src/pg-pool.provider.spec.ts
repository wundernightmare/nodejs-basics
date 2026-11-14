import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import { testCase } from "@base/testing";

import { initSession, PgGuardRailOffError } from "./pg-pool.provider.js";
import type { PostgresBuilderResult } from "./postgres-config.builder.js";

/** A connection that answers the session init and the read-back as told. */
function connection(readBack: Record<string, string> | Error, set?: Error) {
  const queries: string[] = [];
  const client = {
    query(sql: string) {
      queries.push(sql);
      if (sql.startsWith("SET")) return set ? Promise.reject(set) : Promise.resolve({ rows: [] });
      return readBack instanceof Error
        ? Promise.reject(readBack)
        : Promise.resolve({ rows: [readBack] });
    },
  } as unknown as PoolClient;
  return { client, queries };
}

const built = (timeouts: Record<string, number>): PostgresBuilderResult =>
  ({
    sessionInit: Object.entries(timeouts).map(([name, ms]) => `SET ${name} = ${ms}`),
    sessionTimeouts: timeouts,
  }) as PostgresBuilderResult;

const BOTH = { statement_timeout: 30_000, lock_timeout: 5000 };

describe("Postgres session init", () => {
  it("passes a connection on which every configured timeout is in effect", async () => {
    await testCase("NB-1267", "Postgres: session timeouts are read back");
    const { client, queries } = connection({ p0: "30000", p1: "5000" });
    await expect(initSession(client, built(BOTH), "primary")).resolves.toBeUndefined();
    expect(queries[0]).toBe("SET statement_timeout = 30000; SET lock_timeout = 5000");
    expect(queries[1]).toContain("current_setting('statement_timeout')");
    expect(queries[1]).toContain("current_setting('lock_timeout')");
  });

  it("refuses a connection on which a configured timeout reads back as off", async () => {
    await testCase("NB-1268", "Postgres: a timeout that is off fails the checkout");
    const { client } = connection({ p0: "30000", p1: "0" });
    const failure = await initSession(client, built(BOTH), "primary").catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(PgGuardRailOffError);
    expect(failure).toMatchObject({ parameter: "lock_timeout", configuredMs: 5000 });
    expect((failure as Error).message).toContain("ALTER ROLE … SET lock_timeout");
  });

  it("refuses a connection whose SET the server rejected, keeping the cause", async () => {
    await testCase("NB-1269", "Postgres: a refused SET fails the checkout");
    const cause = new Error("invalid value for parameter");
    const { client, queries } = connection({}, cause);
    const failure = await initSession(client, built(BOTH), "primary").catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(PgGuardRailOffError);
    expect((failure as Error).cause).toBe(cause);
    expect(queries).toHaveLength(1); // nothing to read back
  });

  it("a value the server holds differently stands; a failing read-back fails the checkout", async () => {
    await testCase("NB-1270", "Postgres: a differing timeout is the server's to decide");
    // The role or the database pins another value: reported, not fatal.
    const drift = connection({ p0: "10000", p1: "5000" });
    await expect(initSession(drift.client, built(BOTH), "drift")).resolves.toBeUndefined();
    await expect(initSession(drift.client, built(BOTH), "drift")).resolves.toBeUndefined();

    const broken = connection(new Error("connection lost"));
    await expect(initSession(broken.client, built(BOTH), "primary")).rejects.toThrow(
      "connection lost",
    );
    const garbage = connection({ p0: "soon", p1: "5000" });
    await expect(initSession(garbage.client, built(BOTH), "primary")).rejects.toBeInstanceOf(
      PgGuardRailOffError,
    );
  });
});
