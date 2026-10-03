/**
 * Client-side connection metrics for PostgreSQL — the Node.js client's view of
 * its own pool, not what postgres_exporter (pg_stat_activity) already exposes.
 * Valkey's client metrics come with its client (@base/cache valkey-metrics.ts).
 *
 *   db.client.connection.count{state="idle"}     — idle connections in pool
 *   db.client.connection.count{state="used"}     — connections currently checked out
 *   db.client.connection.pending_requests        — requests waiting for a free connection
 *
 * Metric names follow OTEL semantic conventions where applicable:
 *   https://opentelemetry.io/docs/specs/semconv/database/database-metrics/
 */
import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { metrics } from "@opentelemetry/api";
import type { Pool } from "pg";

import { PG_POOL } from "@base/database";

@Injectable()
export class DbMetricsService implements OnModuleInit {
  constructor(@Inject(PG_POOL) private readonly pgPool: Pool) {}

  onModuleInit(): void {
    this.registerPgPoolMetrics();
  }

  private registerPgPoolMetrics(): void {
    const meter = metrics.getMeter("db.client");

    // OTEL semconv: db.client.connection.count with db.client.connection.state
    // attribute ("idle" | "used").  Split across two observe() calls so
    // consumers can sum or filter by state independently.
    const connectionCount = meter.createObservableGauge("db.client.connection.count", {
      description: "Number of connections currently in the pg.Pool, split by state",
      unit: "{connection}",
    });

    // Requests that arrived when all connections were busy and are queued.
    const pendingRequests = meter.createObservableGauge("db.client.connection.pending_requests", {
      description: "Number of pending client requests waiting for a free pg.Pool connection",
      unit: "{request}",
    });

    meter.addBatchObservableCallback(
      (result) => {
        const { totalCount, idleCount, waitingCount } = this.pgPool;
        const usedCount = totalCount - idleCount;
        result.observe(connectionCount, idleCount, { "db.client.connection.state": "idle" });
        result.observe(connectionCount, usedCount, { "db.client.connection.state": "used" });
        result.observe(pendingRequests, waitingCount);
      },
      [connectionCount, pendingRequests],
    );
  }
}
