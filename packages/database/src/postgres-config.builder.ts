/**
 * Centralised PostgreSQL pool configuration.
 *
 * The backend's primary store sits under every HTTP request — connect /
 * pool / failover correctness is load-bearing. This builder takes the
 * DATABASE_* env surface (see infra/config/env.registry.ts) and returns:
 *
 *   1. A `PoolConfig` object ready for `new Pool(opts)`, already merged
 *      with TLS material and pool-size knobs.
 *   2. A `useNative` flag — when true the provider calls
 *      `require('pg').native.Pool` so libpq handles the URL (multi-host,
 *      primary discovery via `target_session_attrs=read-write`). Pure-JS
 *      `pg-connection-string` does NOT parse CSV host lists, so
 *      multi-host URLs require pg-native.
 *   3. A typed retry policy for app-level `withRetry` wrappers around
 *      idempotent SQL.
 *
 * Behaviour preserved for dev: a bare `DATABASE_URL=postgresql://…` with
 * no other knobs yields the same pool shape the code used before this
 * builder (max=20, idle=30s, connect=5s, keepAlive on), plus server-side
 * statement_timeout=30s + idle_in_transaction=60s set on every
 * connection — safe defaults, not legacy behaviour, and disableable via
 * `DATABASE_STATEMENT_TIMEOUT_MS=0`.
 */
import { readFileSync } from "node:fs";

import type { ConfigService } from "@nestjs/config";
import type { PoolConfig } from "pg";

import {
  buildCircuitBreaker,
  buildRetryPolicy,
  type CircuitBreakerConfig,
  type RetryPolicy,
} from "@base/resilience";

export interface PostgresBuilderResult {
  /** Option bag for `new Pool(options)` / `new pg.native.Pool(options)`. */
  poolOptions: PoolConfig;
  /**
   * Filesystem path to a Secret-mounted password file when
   * DATABASE_PASSWORD_FILE is set; otherwise `undefined`. The provider
   * owns the SecretFileWatcher lifecycle (start on init, stop on
   * destroy) and wires its cached value into pg.Pool's `password`
   * callback so new connections pick up rotations without a pod restart.
   */
  passwordFile?: string;
  /** When true the provider must use `require('pg').native.Pool`. */
  useNative: boolean;
  /**
   * Statements executed on every fresh connection via `pool.on('connect')`
   * — carries server-side budgets (statement_timeout, idle-in-transaction)
   * that the pg-level PoolConfig fields above cannot set for all hosts
   * consistently. Empty when the operator disables every timeout.
   */
  sessionInit: string[];
  /** App-level retry policy for idempotent SQL wrapped via `withRetry`. */
  retry: RetryPolicy;
  /**
   * Circuit-breaker settings wrapping the pool's resilient queries. Opens
   * on sustained transient-error rate and fast-fails subsequent wraps
   * with ServiceUnavailable — protects the pool from retry-storm
   * exhaustion during an outage. `DATABASE_CB_*` env keys override; set
   * `DATABASE_CB_ENABLED=false` to opt out entirely.
   */
  circuitBreaker: CircuitBreakerConfig;
}

function readStr(config: ConfigService, key: string): string | undefined {
  const v = config.get<string>(key);
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function readNum(config: ConfigService, key: string, fallback: number): number {
  const raw = readStr(config, key);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function readOptionalNum(config: ConfigService, key: string): number | undefined {
  const raw = readStr(config, key);
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function readBool(config: ConfigService, key: string, fallback: boolean): boolean {
  const raw = readStr(config, key);
  if (raw === undefined) return fallback;
  return raw === "true" || raw === "1";
}

function resolveCa(config: ConfigService): Buffer | undefined {
  const location = readStr(config, "DATABASE_SSL_CA_LOCATION");
  if (location) return readFileSync(location);
  const pem = readStr(config, "DATABASE_SSL_CA_PEM");
  if (pem) return Buffer.from(pem, "utf8");
  return undefined;
}

function resolveExtra(config: ConfigService): Partial<PoolConfig> {
  const raw = readStr(config, "DATABASE_EXTRA_PROPERTIES");
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`DATABASE_EXTRA_PROPERTIES is not valid JSON: ${(err as Error).message}`, {
      cause: err,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("DATABASE_EXTRA_PROPERTIES must be a JSON object");
  }
  return parsed as Partial<PoolConfig>;
}

/**
 * Merge libpq query parameters (target_session_attrs, sslmode, connect
 * timeout, application_name) into the connection string.
 *
 * Env keys win over URL-embedded values so a ConfigMap-rendered URL can
 * be overridden by a Secret-mounted knob without re-templating. Skips
 * params the caller didn't set — the original URL stays untouched
 * otherwise.
 *
 * WHATWG `new URL()` rejects libpq multi-host URIs (`h1:5432,h2:5432`
 * isn't a valid hostname in that spec), so we split on the first `?`
 * ourselves: everything before stays verbatim (preserves the CSV host
 * list libpq understands), everything after is reparsed as
 * URLSearchParams where `set` replaces any existing key. Lets pg-native
 * see the primary-selection knobs on every host.
 */
export function decorateConnectionString(
  rawUrl: string,
  params: Record<string, string | undefined>,
): string {
  const providedEntries = Object.entries(params).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  if (providedEntries.length === 0) return rawUrl;

  // A libpq "key=value" connection string (no URI scheme) has no place
  // to stuff extra query params — libpq reads space-separated pairs.
  // Only URI-shaped strings accept our decoration; return everything
  // else untouched and let libpq parse it as-is.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawUrl)) return rawUrl;

  const queryIdx = rawUrl.indexOf("?");
  const [beforeQuery, query] =
    queryIdx === -1 ? [rawUrl, ""] : [rawUrl.slice(0, queryIdx), rawUrl.slice(queryIdx + 1)];

  const qp = new URLSearchParams(query);
  for (const [k, v] of providedEntries) {
    qp.set(k, v);
  }
  const merged = qp.toString();
  return merged.length > 0 ? `${beforeQuery}?${merged}` : beforeQuery;
}

export function buildPostgresConfig(
  config: ConfigService,
  opts: { variant?: "primary" | "readonly" } = {},
): PostgresBuilderResult {
  const variant = opts.variant ?? "primary";
  const urlKey = variant === "readonly" ? "DATABASE_READONLY_URL" : "DATABASE_URL";
  const rawUrl = config.get<string>(urlKey);
  if (!rawUrl) {
    throw new Error(`${urlKey} is required — the postgres pool cannot be built without it`);
  }

  const useNative = readBool(config, "DATABASE_USE_NATIVE", false);

  // ── Libpq-layer params decorated into the URL ────────────────────────────
  //
  // target_session_attrs, connect_timeout, application_name, sslmode live
  // here so the pg-native branch (which forwards the URL to libpq)
  // inherits them for every host in a CSV multi-host list. Pure-JS pg
  // picks them up too via pg-connection-string — same semantic, single
  // source of truth.
  const connectTimeoutMs = readNum(config, "DATABASE_CONNECT_TIMEOUT_MS", 5000);
  const baseAppName = readStr(config, "DATABASE_APPLICATION_NAME") ?? "mayak-backend";
  const appName = variant === "readonly" ? `${baseAppName}-ro` : baseAppName;

  // target_session_attrs: primary pool defaults to whatever the operator
  // set (usually "read-write" for libpq-native failover; libpq treats
  // unset as "any"). Read-only pool defaults to "any" — in single-node
  // dev that matches the primary; in managed multi-host (Yandex MDB, RDS
  // cluster), operators override to "read-only"/"prefer-standby" to
  // actually reach a replica.
  const readonlyTsa =
    readStr(config, "DATABASE_READONLY_TARGET_SESSION_ATTRS") ??
    readStr(config, "DATABASE_TARGET_SESSION_ATTRS") ??
    "any";
  const targetSessionAttrs =
    variant === "readonly" ? readonlyTsa : readStr(config, "DATABASE_TARGET_SESSION_ATTRS");

  const decorated = decorateConnectionString(rawUrl, {
    target_session_attrs: targetSessionAttrs,
    application_name: appName,
    connect_timeout: String(Math.max(1, Math.ceil(connectTimeoutMs / 1000))),
    sslmode: readStr(config, "DATABASE_SSL_MODE"),
  });

  // ── TLS block on the pg Pool ─────────────────────────────────────────────
  //
  // pg's `ssl` option accepts tls.ConnectionOptions. It overlays libpq's
  // sslmode — use both: the URL param tells libpq to enable TLS, the
  // pool option fills in CA + skipVerify so Node's TLS path has what it
  // needs. No-op when no CA is configured AND sslmode is absent.
  const skipVerify = readBool(config, "DATABASE_SSL_SKIP_VERIFY", false);
  const ca = resolveCa(config);
  const sslMode = readStr(config, "DATABASE_SSL_MODE");
  const sslEnabled =
    ca !== undefined || skipVerify || (sslMode !== undefined && sslMode !== "disable");
  const ssl = sslEnabled
    ? {
        ...(ca ? { ca } : {}),
        rejectUnauthorized: !skipVerify,
      }
    : (false as const);
  // ssl=false (vs undefined) is intentional: pg.Pool's URL parser overlays
  // sslmode → ssl on top-level options when present, but if a downstream
  // adapter (e.g. @prisma/adapter-pg) reconstructs the pool from
  // pool.options, the URL re-parse can pick up stray TLS state. Explicit
  // false in PoolConfig forces ssl off across both the original pool and
  // any clone built off pool.options.

  // ── Session-level server budgets ─────────────────────────────────────────
  //
  // statement_timeout + idle_in_transaction_session_timeout are set via
  // SET on every new connection so they apply to every host in a
  // multi-host / primary-failover pool. Setting them as pg PoolConfig
  // fields would lose them across libpq-native failover.
  const statementTimeoutMs = readNum(config, "DATABASE_STATEMENT_TIMEOUT_MS", 30_000);
  const idleInTxTimeoutMs = readNum(config, "DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS", 60_000);
  const sessionInit: string[] = [];
  if (statementTimeoutMs > 0) {
    sessionInit.push(`SET statement_timeout = ${statementTimeoutMs}`);
  }
  if (idleInTxTimeoutMs > 0) {
    sessionInit.push(`SET idle_in_transaction_session_timeout = ${idleInTxTimeoutMs}`);
  }

  const passwordFile = readStr(config, "DATABASE_PASSWORD_FILE");

  // ── Pool / query knobs ───────────────────────────────────────────────────
  const poolOptions: PoolConfig = {
    connectionString: decorated,
    // TCP keepalive defaults to on — managed LBs (AWS NLB, GCP, Yandex)
    // silently drop idle conns otherwise.
    keepAlive: readBool(config, "DATABASE_KEEPALIVE", true),
    keepAliveInitialDelayMillis: readNum(config, "DATABASE_KEEPALIVE_INITIAL_DELAY_MS", 10_000),
    // Pool size
    max: readNum(config, "DATABASE_POOL_MAX", 20),
    min: readNum(config, "DATABASE_POOL_MIN", 0),
    idleTimeoutMillis: readNum(config, "DATABASE_POOL_IDLE_TIMEOUT_MS", 30_000),
    maxUses: readNum(config, "DATABASE_POOL_MAX_USES", 0),
    connectionTimeoutMillis: connectTimeoutMs,
    // Application name is redundant-set (URL + option) because pg-native
    // reads it from libpq params and pure-JS pg writes it via the option
    // — covering both branches keeps pg_stat_activity clean on either.
    application_name: appName,
    ...(ssl ? { ssl } : {}),
    ...(readOptionalNum(config, "DATABASE_QUERY_TIMEOUT_MS") !== undefined
      ? { query_timeout: readOptionalNum(config, "DATABASE_QUERY_TIMEOUT_MS") }
      : {}),
    // Escape hatch lands last so a purposefully-named field can override
    // a typed one (e.g. set `options: '-c lock_timeout=5s'` for global
    // lock waits without a schema change).
    ...resolveExtra(config),
  };

  const retry = buildRetryPolicy(config, "DATABASE", {
    maxAttempts: 3,
    baseDelayMs: 100,
    maxDelayMs: 5000,
    // Tight by default — a request holds an HTTP slot while it retries,
    // and a 10 s budget leaves ~5 s of headroom under most upstream
    // timeouts. Batch jobs raise via DATABASE_RETRY_BUDGET_MS.
    budgetMs: 10_000,
  });

  const circuitBreaker = buildCircuitBreaker(config, "DATABASE");

  return {
    poolOptions,
    useNative,
    sessionInit,
    retry,
    circuitBreaker,
    ...(passwordFile ? { passwordFile } : {}),
  };
}
