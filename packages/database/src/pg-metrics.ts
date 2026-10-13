/**
 * Client-side Postgres metrics — the names golang-basics' libs/pgx exports.
 * What only the client sees: its pool, and how long its own queries take by
 * operation. Server-side state (connections per database, locks, replication)
 * is postgres_exporter's job, not this process's.
 *
 *   db_pool_connections{pool,state=idle|in_use}   connections in the pool
 *   db_pool_max_connections{pool}                 the pool's bound
 *   db_pool_pending_acquires{pool}                callers waiting for a connection
 *   db_query_duration_seconds{pool,operation}     every statement, traced or not
 *   db_query_errors_total{pool,operation}         statements that failed
 *
 * `operation` is the name the caller gave with `withDbOperation("tasks.create",
 * fn)` (a constant per call site), else the statement's keyword from a fixed
 * list (`select`, `insert`, … `other`) — never query text. Inside a
 * transaction BEGIN and COMMIT count under the same operation.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { metrics } from "@opentelemetry/api";
import type { Pool, PoolClient } from "pg";

/** Latency buckets (seconds) shared with the HTTP and Kafka histograms. */
const LATENCY_BUCKETS_SECONDS = [
  0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

const KEYWORDS = new Set([
  "select",
  "insert",
  "update",
  "delete",
  "with",
  "begin",
  "commit",
  "rollback",
  "savepoint",
  "release",
  "set",
  "show",
  "copy",
  "create",
  "alter",
  "drop",
  "truncate",
  "lock",
  "listen",
  "notify",
  "values",
]);

const operationStorage = new AsyncLocalStorage<string>();

/**
 * Runs `fn` with every statement it issues counted under `operation` — a
 * constant per call site ("tasks.create", "outbox.relay"), never a value.
 */
export function withDbOperation<T>(operation: string, fn: () => T): T {
  return operationStorage.run(operation, fn);
}

/** The label of one statement: the caller's operation, else its keyword. */
export function operationOf(text: string): string {
  const named = operationStorage.getStore();
  if (named !== undefined) return named;
  const keyword = /^\s*([a-z]+)/iu.exec(text)?.[1]?.toLowerCase();
  return keyword !== undefined && KEYWORDS.has(keyword) ? keyword : "other";
}

type QueryFn = (...args: unknown[]) => unknown;

function queryText(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg;
  const text = (arg as { text?: unknown } | null)?.text;
  return typeof text === "string" ? text : undefined;
}

/** Measures every statement on `pool`'s clients and exports the pool's state. */
export function measurePgPool(pool: Pool, poolName: string): void {
  const meter = metrics.getMeter("db.client");
  const duration = meter.createHistogram("db_query_duration_seconds", {
    description: "PostgreSQL statement latency in seconds, by pool and operation.",
    unit: "s",
    advice: { explicitBucketBoundaries: LATENCY_BUCKETS_SECONDS },
  });
  const errors = meter.createCounter("db_query_errors_total", {
    description: "PostgreSQL statements that failed, by pool and operation.",
  });

  const measure = (original: QueryFn): QueryFn =>
    function measuredQuery(this: unknown, ...args: unknown[]): unknown {
      const text = queryText(args[0]);
      const submittable = typeof (args[0] as { submit?: unknown } | null)?.submit === "function";
      if (text === undefined || submittable) return original.apply(this, args);
      const attrs = { pool: poolName, operation: operationOf(text) };
      const started = performance.now();
      const done = (err: unknown): void => {
        duration.record((performance.now() - started) / 1000, attrs);
        if (err !== undefined && err !== null) errors.add(1, attrs);
      };
      const cbIndex = args.findIndex((a) => typeof a === "function");
      if (cbIndex !== -1) {
        const callback = args[cbIndex] as (err: unknown, res: unknown) => void;
        args[cbIndex] = (err: unknown, res: unknown): void => {
          done(err);
          callback(err, res);
        };
        return original.apply(this, args);
      }
      return (original.apply(this, args) as Promise<unknown>).then(
        (res) => {
          done(undefined);
          return res;
        },
        (err: unknown) => {
          done(err);
          throw err;
        },
      );
    };

  pool.on("connect", (client: PoolClient) => {
    const marked = client as PoolClient & { __baseMeasured?: true };
    if (marked.__baseMeasured) return;
    marked.__baseMeasured = true;
    (client as unknown as { query: QueryFn }).query = measure(client.query.bind(client));
  });

  const connections = meter.createObservableGauge("db_pool_connections", {
    description: "Connections in the pool, by pool and state (idle, in_use).",
  });
  const maxConnections = meter.createObservableGauge("db_pool_max_connections", {
    description: "The pool's configured maximum size.",
  });
  const pending = meter.createObservableGauge("db_pool_pending_acquires", {
    description: "Callers waiting for a free connection (the pool is exhausted).",
  });
  const max = pool.options.max ?? 10;
  meter.addBatchObservableCallback(
    (result) => {
      const { totalCount, idleCount, waitingCount } = pool;
      result.observe(connections, idleCount, { pool: poolName, state: "idle" });
      result.observe(connections, totalCount - idleCount, { pool: poolName, state: "in_use" });
      result.observe(maxConnections, max, { pool: poolName });
      result.observe(pending, waitingCount, { pool: poolName });
    },
    [connections, maxConnections, pending],
  );
}
