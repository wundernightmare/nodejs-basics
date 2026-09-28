import { trace } from "@opentelemetry/api";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { captureSpans, integration, meta, testCase, unique } from "@base/testing";

import { pgTarget, tracePgPool } from "./pg-tracing.js";
import { PgUnitOfWork } from "./pg-unit-of-work.service.js";
import { transactionStorage } from "./transaction.storage.js";

/**
 * Query spans against a real Postgres: pool.query and a unit-of-work
 * transaction both land under the caller's span, one span per statement.
 */
const infra = integration("postgres");

describe.skipIf(infra.skip)("pg tracing (integration)", () => {
  meta({
    epic: "nodejs-basics",
    feature: "tracing",
    owner: "@team-platform",
    tags: ["database", "tracing", "integration"],
  });

  const spans = captureSpans();
  const table = unique("traced");
  let pool: Pool;

  beforeAll(async () => {
    const options = { connectionString: infra.url("postgres"), max: 2 };
    pool = new Pool(options);
    tracePgPool(pool, pgTarget(options));
    await pool.query(`CREATE TABLE ${table} (id serial PRIMARY KEY, v text NOT NULL)`);
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${table}`);
    await pool.end();
    spans.stop();
  });

  it("traces pool.query and every statement of a transaction under the caller's span", async () => {
    await testCase("NB-425", "request span → SELECT, BEGIN, INSERT, COMMIT");
    spans.reset();
    const uow = new PgUnitOfWork(pool);
    await trace.getTracer("test").startActiveSpan("request", async (span) => {
      await pool.query(`SELECT count(*) FROM ${table}`);
      await uow.runInTransaction(async () => {
        const client = transactionStorage.getStore() as Pool;
        await client.query(`INSERT INTO ${table} (v) VALUES ($1)`, ["a"]);
      });
      span.end();
    });

    const request = spans.span("request");
    const children = spans
      .spans()
      .filter((s) => s.parentSpanContext?.spanId === request.spanContext().spanId)
      .map((s) => s.attributes["db.operation.name"]);
    expect(children).toEqual(["SELECT", "BEGIN", "INSERT", "COMMIT"]);
  });
});
