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

import { readBool, readInt, readJson, readString } from "@base/config";
import {
  buildCircuitBreaker,
  buildRetryPolicy,
  type CircuitBreakerConfig,
  type RetryPolicy,
} from "@base/resilience";
import { computeJitteredDelay } from "@base/resilient-client";

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

function resolveCa(config: ConfigService): Buffer | undefined {
  const location = readString(config, "VALKEY_CA_LOCATION");
  if (location) return readFileSync(location);
  const pem = readString(config, "VALKEY_CA_PEM");
  if (pem) return Buffer.from(pem, "utf8");
  return undefined;
}

export function buildValkeyConfig(config: ConfigService): ValkeyBuilderResult {
  // Set whenever Valkey is on — the loader checks it (@base/config integrations.ts).
  const url = readString(config, "VALKEY_URL");
  if (url === undefined) throw new Error("VALKEY_URL is not set: Valkey is off");
  const parsed = new URL(url);

  // URL components are the baseline; explicit env vars override (so a
  // ConfigMap-rendered URL can be overridden by a Secret-injected
  // password without re-templating). The URL class returns "" (not
  // undefined) when the component is absent, so drop empties first.
  const urlUser = parsed.username.length > 0 ? parsed.username : undefined;
  const urlPass = parsed.password.length > 0 ? parsed.password : undefined;
  const username = readString(config, "VALKEY_USERNAME") ?? urlUser;
  const password = readString(config, "VALKEY_PASSWORD") ?? urlPass;
  const urlDb = Number(parsed.pathname.replace(/^\//, ""));
  const db = readInt(config, "VALKEY_DB") ?? (Number.isInteger(urlDb) ? urlDb : 0);

  const secure = parsed.protocol === "rediss:" || readBool(config, "VALKEY_TLS");
  const skipVerify = readBool(config, "VALKEY_SKIP_VERIFY");
  const ca = resolveCa(config);

  const tls: TlsConnectionOptions | undefined = secure
    ? {
        ...(ca ? { ca } : {}),
        rejectUnauthorized: !skipVerify,
      }
    : undefined;

  const maxRetriesPerRequest: number | null =
    readString(config, "VALKEY_MAX_RETRIES_PER_REQUEST") === "null"
      ? null
      : readInt(config, "VALKEY_MAX_RETRIES_PER_REQUEST");

  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    username,
    password,
    db,
    tls,
    connectTimeoutMs: readInt(config, "VALKEY_CONNECT_TIMEOUT_MS"),
    commandTimeoutMs: readInt(config, "VALKEY_COMMAND_TIMEOUT_MS"),
    keepaliveMs: readInt(config, "VALKEY_KEEPALIVE_MS"),
    reconnect: {
      baseDelayMs: readInt(config, "VALKEY_RECONNECT_BASE_DELAY_MS"),
      maxDelayMs: readInt(config, "VALKEY_RECONNECT_MAX_DELAY_MS"),
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
    extra: readJson(config, "VALKEY_EXTRA_PROPERTIES") ?? {},
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
