import type { FactoryProvider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import pgDefault, { Pool, type PoolClient } from "pg";

import { pinoLogger } from "@base/logger";
import { DependencyCircuitBreaker } from "@base/resilience";

import { guardPgPool } from "./pg-deadline.js";
import { measurePgPool } from "./pg-metrics.js";
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
 * A configured session timeout is not in effect on a connection: the SET was
 * refused, or the value read back is 0 ("off") — behind a transaction-pooling
 * PgBouncer the SET and the read-back land on different server connections.
 * There, set the timeouts on the role (ALTER ROLE … SET statement_timeout = …)
 * and zero the DATABASE_*_TIMEOUT_MS keys.
 */
export class PgGuardRailOffError extends Error {
  constructor(
    readonly parameter: string,
    readonly configuredMs: number,
    options?: ErrorOptions,
  ) {
    super(
      `postgres: ${parameter} is not in effect though the config sets ${configuredMs}ms — ` +
        `a pooler in transaction mode, or a value the server rejects? Set it on the role or ` +
        `database (ALTER ROLE … SET ${parameter}) and zero it in the config, or fix the value`,
      options,
    );
    this.name = "PgGuardRailOffError";
  }
}

/** Pools that already reported a timeout the server holds at another value. */
const warnedDrift = new Set<string>();

export async function initSession(
  client: PoolClient,
  built: PostgresBuilderResult,
  label: string,
): Promise<void> {
  const parameters = Object.entries(built.sessionTimeouts);
  try {
    await client.query(built.sessionInit.join("; "));
  } catch (err) {
    const [parameter, configured] = parameters[0] ?? ["session init", 0];
    throw new PgGuardRailOffError(parameter, configured, { cause: err });
  }
  if (parameters.length === 0) return;
  // The server's own arithmetic: current_setting() prints "30s", "500ms", "0".
  const columns = parameters.map(
    ([name], i) =>
      `(extract(epoch FROM current_setting('${name}')::interval) * 1000)::bigint::text AS p${i}`,
  );
  const { rows } = await client.query<Record<string, string>>(`SELECT ${columns.join(", ")}`);
  for (const [i, [name, configured]] of parameters.entries()) {
    const effective = Number(rows[0]?.[`p${i}`]);
    if (effective === configured) continue;
    if (effective === 0 || !Number.isFinite(effective)) {
      throw new PgGuardRailOffError(name, configured);
    }
    const key = `${label}:${name}`;
    if (warnedDrift.has(key)) continue;
    warnedDrift.add(key);
    logger.warn(
      {
        "pg.pool": label,
        "pg.parameter": name,
        "pg.configured_ms": configured,
        "pg.effective_ms": effective,
      },
      "Postgres session timeout differs from the config; the server's value stands",
    );
  }
}

/**
 * Shared pool constructor. Both the primary (read-write) and the read-only
 * provider funnel through this to keep session-init + error handling
 * identical.
 */
function buildPool(built: PostgresBuilderResult, label: "primary" | "readonly"): Pool {
  // Each fresh connection — including a libpq-native reconnect after
  // a primary failover — receives the full session-init batch, as one
  // query, before the pool hands it out: pg-pool's `verify` holds the
  // caller back until it is done. (Run from a `connect` listener instead,
  // the statements would queue behind each other and the caller's first
  // query behind them — pg deprecates a query issued while another runs.)
  //
  // Then the timeouts are read back. A connection on which a configured
  // timeout is not in effect is NOT handed out (PgGuardRailOffError): a
  // statement without statement_timeout, a lock wait without lock_timeout
  // is exactly the incident the setting exists to prevent, and it would
  // happen silently. A persistent cause — a value the server rejects, a
  // transaction-pooling proxy that sends the SET and the next statement to
  // different backends — fails /readyz, so a rollout stops instead of
  // shipping an unguarded pool.
  const verify = (client: PoolClient, done: (err?: Error) => void): void => {
    initSession(client, built, label).then(
      () => {
        done();
      },
      (err: unknown) => {
        logger.error(
          { err, "pg.pool": label, "event.action": "pg.guard_rail_off" },
          "Postgres session timeouts are not in effect — connection discarded",
        );
        done(err instanceof Error ? err : new Error(String(err)));
      },
    );
  };
  const pool = new (resolvePoolCtor(built.useNative))({
    ...built.poolOptions,
    ...(built.sessionInit.length > 0 && { verify }),
  });
  // CLIENT spans for every query (pg-tracing.ts), tagged with this pool's target.
  tracePgPool(pool, { ...pgTarget(built.poolOptions), "db.client.connection.pool.name": label });
  // The request budget (pg-deadline.ts); registered after tracing so it runs first.
  guardPgPool(pool);
  // db_pool_* and db_query_* (pg-metrics.ts), labelled with this pool.
  measurePgPool(pool, label);

  // A connection that breaks emits "error" on its client. pg-pool listens only
  // while the client is idle; one that is checked out — a unit of work between
  // two statements — has no listener, and an "error" event without one is an
  // uncaught exception: the database restarting would take the process down.
  // The listener stays for the life of the connection; the failure itself
  // reaches the caller through the next query, which rejects.
  pool.on("connect", (client: PoolClient) => {
    client.on("error", (err: Error) => {
      logger.warn({ err, "pg.pool": label }, "Postgres connection error");
    });
  });

  pool.on("error", (err) => {
    // pg-pool re-emits the error of an idle client here (it is already logged
    // by the listener above). Without a listener this event, too, would crash
    // the process on a broken socket the pool replaces on the next query.
    logger.debug({ err, "pg.pool": label }, "Postgres pool dropped an idle connection");
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
 *   - Run the session init (pg-pool `verify`) so statement_timeout,
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
          return !/^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EPIPE)$/u.test(code);
        }
        // Anything without a Node error code is a Postgres-level error;
        // exclude from the breaker budget.
        return true;
      },
    });
  },
};
