import { EventEmitter } from "node:events";

import type { Pool, PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { captureMetrics, meta, type MetricsCapture, metricValue, testCase } from "@base/testing";

import { measurePgPool, operationOf, withDbOperation } from "./pg-metrics.js";

/** A pool that hands out one scripted client and reports fixed counts. */
function fakePool(fail: (text: string) => boolean): { pool: Pool; client: PoolClient } {
  const client = {
    query: (text: string) =>
      fail(text) ? Promise.reject(new Error("boom")) : Promise.resolve({ rows: [] }),
  } as unknown as PoolClient;
  const pool = Object.assign(new EventEmitter(), {
    options: { max: 7 },
    totalCount: 3,
    idleCount: 1,
    waitingCount: 2,
  }) as unknown as Pool;
  return { pool, client };
}

describe("Postgres client metrics", () => {
  meta({ epic: "nodejs-basics", feature: "database", owner: "@team-platform", tags: ["metrics"] });
  let capture: MetricsCapture;
  beforeEach(() => {
    capture = captureMetrics();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it("labels a statement with the caller's operation, else a known keyword, never its text", async () => {
    await testCase("NB-1050", "the operation label is bounded");
    expect(operationOf("  SELECT * FROM tasks WHERE id = 'x'")).toBe("select");
    expect(operationOf("VACUUM tasks")).toBe("other");
    expect(withDbOperation("tasks.get", () => operationOf("SELECT 1"))).toBe("tasks.get");
  });

  it("times every statement, counts failures, and exports the pool's state", async () => {
    await testCase("NB-1051", "db_query_* and db_pool_* per pool");
    const { pool, client } = fakePool((t) => t.startsWith("INSERT"));
    measurePgPool(pool, "primary");
    pool.emit("connect", client);
    await withDbOperation("tasks.list", () => client.query("SELECT 1"));
    await expect(withDbOperation("tasks.create", () => client.query("INSERT 1"))).rejects.toThrow();
    await client.query("COMMIT");

    const text = await capture.scrape();
    const count = (operation: string): number =>
      metricValue(text, "db_query_duration_seconds_count", { pool: "primary", operation });
    expect([count("tasks.list"), count("tasks.create"), count("commit")]).toEqual([1, 1, 1]);
    expect(metricValue(text, "db_query_errors_total", { operation: "tasks.create" })).toBe(1);
    expect(metricValue(text, "db_query_errors_total", { operation: "tasks.list" })).toBe(-1);
    expect(metricValue(text, "db_pool_connections", { pool: "primary", state: "in_use" })).toBe(2);
    expect(metricValue(text, "db_pool_connections", { pool: "primary", state: "idle" })).toBe(1);
    expect(metricValue(text, "db_pool_max_connections", { pool: "primary" })).toBe(7);
    expect(metricValue(text, "db_pool_pending_acquires", { pool: "primary" })).toBe(2);
  });
});
