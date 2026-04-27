/**
 * Client-side connection metrics for Valkey and PostgreSQL.
 *
 * Intentionally avoids duplicating what database-side exporters already expose
 * (valkey_exporter server stats, postgres_exporter pg_stat_activity).
 * Everything here is the Node.js client's view of its own state.
 *
 * Valkey (iovalkey):
 *   valkey.client.command_queue_size  — commands dispatched but awaiting reply
 *   valkey.client.connected           — 1 = ready, 0 = any other state
 *
 * PostgreSQL (pg.Pool):
 *   db.client.connection.count{state="idle"}     — idle connections in pool
 *   db.client.connection.count{state="used"}     — connections currently checked out
 *   db.client.connection.pending_requests        — requests waiting for a free connection
 *
 * Metric names follow OTEL semantic conventions where applicable:
 *   https://opentelemetry.io/docs/specs/semconv/database/database-metrics/
 */
import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { metrics } from "@opentelemetry/api";
import type { Redis as Valkey } from "iovalkey";
import type { Pool } from "pg";

import { PG_POOL } from "@base/database";
import { VALKEY_CLIENT } from "@base/cache";

// iovalkey exposes commandQueue as a public property but does not re-export its
// internal Deque type.  Access it via a structural alias to stay type-safe.
type ValkeyWithQueue = Valkey & { commandQueue: { length: number } };

@Injectable()
export class DbMetricsService implements OnModuleInit {
  constructor(
    @Inject(VALKEY_CLIENT) private readonly valkey: Valkey,
    @Inject(PG_POOL) private readonly pgPool: Pool,
  ) {}

  onModuleInit(): void {
    this.registerValkeyMetrics();
    this.registerPgPoolMetrics();
  }

  // ─── Valkey ───────────────────────────────────────────────────────────────

  private registerValkeyMetrics(): void {
    const meter = metrics.getMeter("valkey.client");

    const commandQueueSize = meter.createObservableGauge("valkey.client.command_queue_size", {
      description: "Commands dispatched to Valkey that are awaiting a reply from the server",
      unit: "{command}",
    });

    const connected = meter.createObservableGauge("valkey.client.connected", {
      description: "1 if the iovalkey client is in the ready state, 0 otherwise",
    });

    meter.addBatchObservableCallback(
      (result) => {
        const client = this.valkey as ValkeyWithQueue;
        result.observe(commandQueueSize, client.commandQueue.length);
        result.observe(connected, this.valkey.status === "ready" ? 1 : 0, {
          "valkey.client.status": this.valkey.status,
        });
      },
      [commandQueueSize, connected],
    );
  }

  // ─── PostgreSQL ───────────────────────────────────────────────────────────

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
