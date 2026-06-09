/**
 * Centralised Valkey/Redis client configuration.
 *
 * Both consumers — the global Nest provider (`valkey.provider.ts`) and the
 * BullMQ connection factory (`bullmq-connection.factory.ts`) — funnel
 * through this builder so security, socket tunables, pool/retry shape, and
 * the reconnect curve are read from one VALKEY_* env surface.
 *
 * BullMQ has one quirk: ioredis blocking commands (`BRPOPLPUSH`, etc.)
 * cannot be retried by the client, so BullMQ requires
 * `maxRetriesPerRequest: null`. The builder exposes two derived helpers,
 * `toClientOptions` (for the regular Nest-managed Valkey) and
 * `toBullMqOptions` (forces null), so callers cannot accidentally pick the
 * wrong shape.
 *
 * Defaults preserve current dev behaviour: a `redis://localhost:6379`
 * URL with no extra env keys yields a plaintext connection with the
 * pre-existing `maxRetriesPerRequest=3` + `lazyConnect` semantics.
 */
import { readFileSync } from "node:fs";
import type { ConnectionOptions as TlsConnectionOptions } from "node:tls";

import type { ConfigService } from "@nestjs/config";

import { computeJitteredDelay } from "@base/resilient-client";
import {
  buildCircuitBreaker,
  buildRetryPolicy,
  type CircuitBreakerConfig,
  type RetryPolicy,
} from "@base/resilience";

/**
 * Shared parsed shape — flat enough for both the Valkey provider and the
 * BullMQ factory to consume without further env reads.
 */
export interface ValkeyBuilderResult {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db: number;
  /** TLS options block when `secure` resolves to true. */
  tls?: TlsConnectionOptions;
  /** Connect-timeout in ms (TCP setup + TLS handshake). */
  connectTimeoutMs: number;
  /** Per-command timeout in ms — clamps a single Valkey response wait. */
  commandTimeoutMs: number;
  /**
   * TCP keepalive idle delay (ms). 0 = disabled (driver default).
   * iovalkey accepts this on `keepAlive` (number of ms or boolean).
   */
  keepaliveMs: number;
  /**
   * Reconnect curve — used to construct an iovalkey `retryStrategy`. Both
   * fields are passed verbatim to the shared `computeJitteredDelay` helper.
   */
  reconnect: { baseDelayMs: number; maxDelayMs: number };
  /**
   * Per-command retry cap. `null` is the BullMQ-required value for
   * connections that issue blocking commands; positive integers are safe
   * for the regular pool.
   */
  maxRetriesPerRequest: number | null;
  /** App-level retry policy for `withRetry` wrappers around idempotent calls. */
  retry: RetryPolicy;
  /**
   * Circuit-breaker settings — fast-fails commands with ServiceUnavailable
   * when Valkey is persistently unreachable. Off by default on the
   * request-path hot loop, enable per-deployment via VALKEY_CB_ENABLED=true.
   */
  circuitBreaker: CircuitBreakerConfig;
  /** Escape hatch — shallow-merged into the driver options. */
  extra: Record<string, unknown>;
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

function readBool(config: ConfigService, key: string, fallback: boolean): boolean {
  const raw = readStr(config, key);
  if (raw === undefined) return fallback;
  return raw === "true" || raw === "1";
}

function resolveCa(config: ConfigService): Buffer | undefined {
  const location = readStr(config, "VALKEY_CA_LOCATION");
  if (location) return readFileSync(location);
  const pem = readStr(config, "VALKEY_CA_PEM");
  if (pem) return Buffer.from(pem, "utf8");
  return undefined;
}

function resolveExtra(config: ConfigService): Record<string, unknown> {
  const raw = readStr(config, "VALKEY_EXTRA_PROPERTIES");
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`VALKEY_EXTRA_PROPERTIES is not valid JSON: ${(err as Error).message}`, {
      cause: err,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("VALKEY_EXTRA_PROPERTIES must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export function buildValkeyConfig(config: ConfigService): ValkeyBuilderResult {
  const url = config.get<string>("VALKEY_URL") ?? "redis://localhost:6379";
  const parsed = new URL(url);

  // URL components are the baseline; explicit env vars override (so a
  // ConfigMap-rendered URL can be overridden by a Secret-injected
  // password without re-templating). The URL class returns "" (not
  // undefined) when the component is absent, so drop empties first.
  const urlUser = parsed.username.length > 0 ? parsed.username : undefined;
  const urlPass = parsed.password.length > 0 ? parsed.password : undefined;
  const username = readStr(config, "VALKEY_USERNAME") ?? urlUser;
  const password = readStr(config, "VALKEY_PASSWORD") ?? urlPass;
  const dbStr = readStr(config, "VALKEY_DB") ?? parsed.pathname.replace(/^\//, "");
  const db = Number.isFinite(Number(dbStr)) && dbStr ? Number(dbStr) : 0;

  const secure = parsed.protocol === "rediss:" || readBool(config, "VALKEY_TLS", false);
  const skipVerify = readBool(config, "VALKEY_SKIP_VERIFY", false);
  const ca = resolveCa(config);

  const tls: TlsConnectionOptions | undefined = secure
    ? {
        ...(ca ? { ca } : {}),
        rejectUnauthorized: !skipVerify,
      }
    : undefined;

  const maxRetriesRaw = readStr(config, "VALKEY_MAX_RETRIES_PER_REQUEST");
  const maxRetriesPerRequest: number | null =
    maxRetriesRaw === "null"
      ? null
      : Number.isFinite(Number(maxRetriesRaw))
        ? Number(maxRetriesRaw)
        : 3;

  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    username,
    password,
    db,
    tls,
    connectTimeoutMs: readNum(config, "VALKEY_CONNECT_TIMEOUT_MS", 5000),
    commandTimeoutMs: readNum(config, "VALKEY_COMMAND_TIMEOUT_MS", 5000),
    keepaliveMs: readNum(config, "VALKEY_KEEPALIVE_MS", 0),
    reconnect: {
      baseDelayMs: readNum(config, "VALKEY_RECONNECT_BASE_DELAY_MS", 100),
      maxDelayMs: readNum(config, "VALKEY_RECONNECT_MAX_DELAY_MS", 5000),
    },
    maxRetriesPerRequest,
    retry: buildRetryPolicy(config, "VALKEY", {
      maxAttempts: 3,
      baseDelayMs: 50,
      maxDelayMs: 1000,
      budgetMs: 5000,
    }),
    circuitBreaker: buildCircuitBreaker(config, "VALKEY", {
      // Valkey sits on the request-path hot loop — a tripped breaker
      // means every HTTP handler gets a fast 503 instead of waiting
      // through the 5 s retry budget. That's the right trade, but
      // default-off keeps the opossum timer machinery from running on
      // every pod where Valkey is uncontested; flip VALKEY_CB_ENABLED=true
      // per-deployment to activate.
      enabled: false,
      timeoutMs: 5_000,
      errorThresholdPct: 50,
      volumeThreshold: 20,
      resetTimeoutMs: 15_000,
    }),
    extra: resolveExtra(config),
  };
}

/**
 * Reconnect strategy — exponential full-jitter via the shared backoff
 * helper. iovalkey calls this with `times` = the 1-based attempt count.
 *
 * Returning `void` here would tell iovalkey to stop reconnecting; we always
 * return a number so the client keeps trying until the operator restarts
 * the pod or the network heals.
 */
export function buildRetryStrategy(
  reconnect: ValkeyBuilderResult["reconnect"],
): (times: number) => number {
  return (times) =>
    computeJitteredDelay(
      {
        minTimeout: reconnect.baseDelayMs,
        maxTimeout: reconnect.maxDelayMs,
        factor: 2,
      },
      Math.max(0, times - 1),
    );
}

/**
 * Shape the parsed config into the option bag the regular Valkey client
 * expects. Adds `lazyConnect` + `enableOfflineQueue=false` so the
 * legacy semantics survive (commands fail-fast when disconnected, no
 * silent buffering).
 */
export function toClientOptions(result: ValkeyBuilderResult): Record<string, unknown> {
  return {
    host: result.host,
    port: result.port,
    ...(result.username ? { username: result.username } : {}),
    ...(result.password ? { password: result.password } : {}),
    db: result.db,
    ...(result.tls ? { tls: result.tls } : {}),
    connectTimeout: result.connectTimeoutMs,
    commandTimeout: result.commandTimeoutMs,
    keepAlive: result.keepaliveMs > 0 ? result.keepaliveMs : 0,
    maxRetriesPerRequest: result.maxRetriesPerRequest,
    lazyConnect: true,
    enableOfflineQueue: false,
    retryStrategy: buildRetryStrategy(result.reconnect),
    ...result.extra,
  };
}

/**
 * Shape the parsed config for BullMQ's ConnectionOptions (ioredis under
 * the hood). Forces `maxRetriesPerRequest: null` because BullMQ's worker
 * blocking commands cannot tolerate the per-call retry loop, and
 * `enableReadyCheck: false` because BullMQ does its own ping handshake.
 *
 * Note: `commandTimeout` is deliberately NOT propagated. BullMQ workers issue
 * long-lived blocking commands (BZPOPMIN/BRPOPLPUSH) that legitimately outlast
 * any per-command timeout — setting one makes ioredis abort the blocking poll
 * with "Command timed out" and the worker never drains the queue.
 */
export function toBullMqOptions(result: ValkeyBuilderResult): Record<string, unknown> {
  return {
    host: result.host,
    port: result.port,
    ...(result.username ? { username: result.username } : {}),
    ...(result.password ? { password: result.password } : {}),
    db: result.db,
    ...(result.tls ? { tls: result.tls } : {}),
    connectTimeout: result.connectTimeoutMs,
    keepAlive: result.keepaliveMs > 0 ? result.keepaliveMs : 0,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
    retryStrategy: buildRetryStrategy(result.reconnect),
    ...result.extra,
  };
}
