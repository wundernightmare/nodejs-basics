import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { PoolClient } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { captureSpans, meta, testCase } from "@base/testing";

import { pgTarget, tracePgClient } from "./pg-tracing.js";

const spans = captureSpans();

const inSpan = <T>(fn: () => Promise<T>): Promise<T> =>
  trace.getTracer("test").startActiveSpan("parent", async (span) => {
    try {
      return await fn();
    } finally {
      span.end();
    }
  });

/** A client whose query() answers from `reply` (a value, or an Error to reject with). */
function fakeClient(reply: unknown = { rows: [] }): PoolClient {
  const client = {
    query(...args: unknown[]): unknown {
      const cb = args.find((a) => typeof a === "function") as
        | ((err: unknown, res: unknown) => void)
        | undefined;
      const err = reply instanceof Error ? reply : undefined;
      if (cb !== undefined) {
        cb(err, err === undefined ? reply : undefined);
        return undefined;
      }
      return err === undefined ? Promise.resolve(reply) : Promise.reject(err);
    },
  } as unknown as PoolClient;
  tracePgClient(client, pgTarget({ connectionString: "postgresql://app@db.internal:5433/app" }));
  return client;
}

describe("pg tracing", () => {
  meta({
    epic: "nodejs-basics",
    feature: "tracing",
    owner: "@team-platform",
    tags: ["database", "tracing", "unit"],
  });

  beforeEach(() => {
    spans.reset();
  });
  afterAll(() => {
    spans.stop();
  });

  it("derives the target from single- and multi-host connection strings", async () => {
    await testCase("NB-421", "server.address / port / db.namespace from DATABASE_URL");
    expect(
      pgTarget({
        connectionString: "postgresql://u:p%40ss@db.internal:5433/my%20db?sslmode=require",
      }),
    ).toEqual({
      "db.system.name": "postgresql",
      "server.address": "db.internal",
      "server.port": 5433,
      "db.namespace": "my db",
    });
    expect(pgTarget({ connectionString: "postgresql://u@h1:5432,h2:5432/app" })).toMatchObject({
      "server.address": "h1",
      "db.namespace": "app",
    });
    expect(pgTarget({ host: "localhost", port: 5432, database: "app" })).toMatchObject({
      "server.address": "localhost",
      "server.port": 5432,
    });
  });

  it("wraps a query issued inside a span in a CLIENT span with the parameterised text", async () => {
    await testCase("NB-422", "SELECT → `SELECT app`, values never recorded");
    const client = fakeClient();
    await inSpan(() => client.query("select * from tasks where id = $1", ["secret-id"]));

    const span = spans.span("SELECT app");
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes).toMatchObject({
      "db.system.name": "postgresql",
      "db.operation.name": "SELECT",
      "db.query.text": "select * from tasks where id = $1",
      "server.address": "db.internal",
      "server.port": 5433,
    });
    expect(JSON.stringify(span.attributes)).not.toContain("secret-id");
  });

  it("leaves queries without a parent span untraced", async () => {
    await testCase("NB-423", "readiness SELECT 1 opens no root trace");
    await fakeClient().query("SELECT 1");
    expect(spans.spans()).toHaveLength(0);
  });

  it("fails the span with the SQLSTATE on a rejected query, in both call styles", async () => {
    await testCase("NB-424", "unique violation → failed span with db.response.status_code");
    const err = Object.assign(new Error("duplicate key"), { code: "23505" });
    const client = fakeClient(err);
    await expect(inSpan(() => client.query("INSERT INTO t VALUES (1)"))).rejects.toThrow(
      "duplicate key",
    );
    await inSpan(
      () =>
        new Promise<void>((resolve) => {
          (client.query as unknown as (t: string, cb: () => void) => void)(
            "UPDATE t SET v = 1",
            () => {
              resolve();
            },
          );
        }),
    );

    for (const name of ["INSERT", "UPDATE"]) {
      const span = spans.span(`${name} app`);
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes["db.response.status_code"]).toBe("23505");
    }
  });
});
