import type { FactoryProvider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import pgDefault, { Pool, type PoolClient } from "pg";

import { pinoLogger } from "@base/logger";
import { DependencyCircuitBreaker } from "@base/resilience";

import { guardPgPool } from "./pg-deadline.js";
import { pgTarget, tracePgPool } from "./pg-tracing.js";
import { buildPostgresConfig, type PostgresBuilderResult } from "./postgres-config.builder.js";

/** DI token for the shared pg.Pool instance (primary / read-write). */
export const PG_POOL = Symbol("PG_POOL");

/**
 * DI token for the read-only pg.Pool instance. When `DATABASE_READONLY_URL`
 * is set, this is a separate pool pointed at a replica (or multi-host
 * replica list with `target_session_attrs=any`). When the env is unset the
 * provider aliases the primary pool so callers can depend on this token
 * unconditionally — single-node dev pays no cost, managed prod gets a real
 * replica pool the moment the operator wires one up.
 */
export const PG_POOL_READONLY = Symbol("PG_POOL_READONLY");

/** DI token for the postgres config (pool options, retry policy, …). */
export const PG_CONFIG = Symbol("PG_CONFIG");

/** DI token for the postgres circuit breaker (shared across all call sites). */
export const PG_BREAKER = Symbol("PG_BREAKER");

const logger = pinoLogger.child({ "log.logger": "PgPool" });

/**
 * Resolve the `Pool` constructor the app should use.
 *
 * With `DATABASE_USE_NATIVE=true` we ask pg for the libpq-backed
 * variant: `require('pg').native.Pool`. libpq handles multi-host
 * URIs + `target_session_attrs=read-write` — our single-process path
 * to automatic primary discovery on failover. The pure-JS parser
 * (pg-connection-string) cannot parse CSV host lists.
 *
 * Falls back to the pure-JS Pool with a warning when native is
 * requested but missing. Never crashes the pod on that — a broken
 * pg-native install should be visible via logs, not via a
 * CrashLoopBackOff that hides the actual misconfiguration.
 */
function resolvePoolCtor(useNative: boolean): typeof Pool {
  if (!useNative) return Pool;
  const nativeNamespace = (pgDefault as unknown as { native?: { Pool: typeof Pool } }).native;
  if (nativeNamespace?.Pool) return nativeNamespace.Pool;
  logger.warn(
    "DATABASE_USE_NATIVE=true but require('pg').native is unavailable — " +
      "falling back to pure-JS pg. Multi-host URIs will NOT honour " +
      "target_session_attrs. Rebuild the image without the pg-native removal " +
      "step, or install the pg-native package.",
  );
  return Pool;
}

/**
 * Shared pool constructor. Both the primary (read-write) and the read-only
 * provider funnel through this to keep session-init + error handling
 * identical.
 */
function buildPool(built: PostgresBuilderResult, label: "primary" | "readonly"): Pool {
  const pool = new (resolvePoolCtor(built.useNative))(built.poolOptions);
  // CLIENT spans for every query (pg-tracing.ts), tagged with this pool's target.
  tracePgPool(pool, { ...pgTarget(built.poolOptions), "db.client.connection.pool.name": label });
  // The request budget (pg-deadline.ts); registered after tracing so it runs first.
  guardPgPool(pool);

  // Each fresh connection — including a libpq-native reconnect after
  // a primary failover — receives the full session-init batch. Errors
  // here would tear down the connection; we catch and log instead so
  // a transient SET failure doesn't turn into a pod-wide outage. A
  // persistently-failing SET shows up as a steady stream of warnings,
  // which is the right signal: operator fixes the server-side setting
  // or drops the client-side knob.
  if (built.sessionInit.length > 0) {
    pool.on("connect", (client: PoolClient) => {
      Promise.all(built.sessionInit.map((stmt) => client.query(stmt))).catch((err) => {
        logger.warn(
          {
            err,
            "pg.pool": label,
            statements: built.sessionInit,
          },
          "Postgres session init failed — connection remains usable",
        );
      });
    });
  }

  pool.on("error", (err) => {
    // pg emits these on idle-client errors. Leaving the listener
    // unregistered would crash the process on a broken socket, which
    // the pool is perfectly capable of replacing on the next query.
    logger.warn({ err, "pg.pool": label }, "Postgres pool idle-client error");
  });

  return pool;
}

/**
 * Provides a single pg.Pool instance shared across the application.
 *
 * Responsibilities:
 *   - Build options via `buildPostgresConfig` so every DATABASE_* env
 *     key flows through a single point (see @base/config env.registry.ts
 *     and the companion builder spec for the full surface).
 *   - Pick between pg and pg-native depending on DATABASE_USE_NATIVE —
 *     the only way to get multi-host primary selection in this process.
 *   - Register an `on('connect')` hook so statement_timeout,
 *     idle_in_transaction_session_timeout, and any other session-level
 *     SET statements produced by the builder run once per new backend
 *     connection (surviving libpq failover to a different host).
 *
 * Pool cleanup: DatabaseLifecycleService.onApplicationShutdown() calls
 * pool.end().
 */
export const pgPoolProvider: FactoryProvider<Pool> = {
  provide: PG_POOL,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Pool => buildPool(buildPostgresConfig(config), "primary"),
};

/**
 * Provides a read-only pg.Pool. When `DATABASE_READONLY_URL` is set, this
 * is a separate pool with `target_session_attrs=any` (override via
 * `DATABASE_READONLY_TARGET_SESSION_ATTRS`) and an `-ro` suffix on
 * `application_name` so pg_stat_activity distinguishes it from primary.
 * Every other tunable (pool size, timeouts, TLS, session-init,
 * statement_timeout) is inherited from DATABASE_* — operators override on
 * a single surface rather than duplicating twenty env keys.
 *
 * When `DATABASE_READONLY_URL` is unset the provider returns the primary
 * pool (aliased via Inject). Consumers can depend on PG_POOL_READONLY
 * unconditionally — single-node dev pays no cost, managed prod gets a
 * real replica the moment the operator wires one up.
 *
 * Cleanup: DatabaseLifecycleService ends both pools when they are separate,
 * and only the primary in alias mode.
 */
export const pgReadonlyPoolProvider: FactoryProvider<Pool> = {
  provide: PG_POOL_READONLY,
  inject: [ConfigService, PG_POOL],
  useFactory: (config: ConfigService, primary: Pool): Pool => {
    const readonlyUrl = config.get<string>("DATABASE_READONLY_URL");
    if (typeof readonlyUrl !== "string" || readonlyUrl.length === 0) {
      // Alias the primary pool. pg.Pool has no "clone" — returning the
      // same reference is intentional; reads that don't care about
      // primary/replica topology still work against the single node.
      return primary;
    }
    return buildPool(buildPostgresConfig(config, { variant: "readonly" }), "readonly");
  },
};

/**
 * Exposes the full builder result (retry policy, useNative flag,
 * sessionInit, poolOptions) for callers that need a retry wrapper
 * around an idempotent query. Kept as a sibling provider to PG_POOL
 * so tests can swap it without faking a Pool.
 */
export const pgConfigProvider: FactoryProvider<PostgresBuilderResult> = {
  provide: PG_CONFIG,
  inject: [ConfigService],
  useFactory: (config: ConfigService): PostgresBuilderResult => buildPostgresConfig(config),
};

/**
 * Singleton circuit breaker for the postgres pool — fast-fails queries
 * with ServiceUnavailable when the upstream has been persistently
 * failing. Shared across every call site (raw pool.query, Prisma
 * $queryRaw, the migration job's Prisma CLI is NOT affected — it runs
 * in a separate process without DI). Callers that want both retries
 * and the breaker compose `breaker.execute(() => withRetry(...))`.
 * Node.js error codes for network-level failures are treated as
 * "counts toward breaker"; any other error is filtered out so a SQL
 * syntax error from one bad query doesn't trip the breaker on
 * everyone else's reads.
 */
export const pgBreakerProvider: FactoryProvider<DependencyCircuitBreaker> = {
  provide: PG_BREAKER,
  inject: [ConfigService],
  useFactory: (config: ConfigService): DependencyCircuitBreaker => {
    const { circuitBreaker } = buildPostgresConfig(config);
    return new DependencyCircuitBreaker("postgres", circuitBreaker, {
      errorFilter: (err) => {
        // `true` = don't count towards open. Only network / pool
        // exhaustion failures should trip the breaker — a constraint
        // violation or syntax error is a caller bug, not a broker outage.
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (typeof code === "string") {
          return !/^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EPIPE)$/.test(code);
        }
        // Anything without a Node error code is a Postgres-level error;
        // exclude from the breaker budget.
        return true;
      },
    });
  },
};
