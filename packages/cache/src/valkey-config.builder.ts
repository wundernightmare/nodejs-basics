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
 * With the defaults, a `redis://localhost:6379` URL with no extra env
 * keys yields a plaintext connection with `maxRetriesPerRequest=3` +
 * `lazyConnect` semantics.
 */
import { readFileSync } from "node:fs";
import type { ConnectionOptions as TlsConnectionOptions } from "node:tls";

import type { ConfigService } from "@nestjs/config";

import { Secret } from "@base/common";
import { readBool, readInt, readJson, readString } from "@base/config";
import {
  buildCircuitBreaker,
  buildRetryPolicy,
  type CircuitBreakerConfig,
  computeJitteredDelay,
  type RetryPolicy,
} from "@base/resilience";

import type { CompareAndSetMode } from "./valkey-cas.js";

export type ValkeyTopology = "standalone" | "cluster" | "sentinel";

export interface ValkeyAddress {
  host: string;
  port: number;
}

/**
 * Shared parsed shape — flat enough for both the Valkey provider and the
 * BullMQ factory to consume without further env reads.
 */
export interface ValkeyBuilderResult {
  topology: ValkeyTopology;
  addresses: ValkeyAddress[];
  host: string;
  port: number;
  masterSet?: string | undefined;
  compareAndSet: CompareAndSetMode;
  username?: string | undefined;
  /** Never a plain string: it cannot be logged or serialised by accident; `expose()` at the driver. */
  password: Secret;
  db: number;
  /** TLS options block when `secure` resolves to true. */
  tls?: TlsConnectionOptions | undefined;
  /** Connect-timeout in ms (TCP setup + TLS handshake). */
  connectTimeoutMs: number;
  /** Per-command timeout in ms — clamps a single Valkey response wait. */
  commandTimeoutMs: number;
  /**
   * How long a connection may stay silent after something was written to it
   * before it is dropped and replaced (ms; 0 = never). `commandTimeout` only
   * fails the command — the dead connection would stay, and every next
   * command would wait out its own timeout on it.
   */
  socketTimeoutMs: number;
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

function parseAddress(raw: string): ValkeyAddress {
  const parsed = new URL(`redis://${raw}`);
  if (parsed.hostname === "") throw new Error("VALKEY_URL contains an empty address");
  return { host: parsed.hostname, port: parsed.port === "" ? 6379 : Number(parsed.port) };
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
  const password = Secret.of(readString(config, "VALKEY_PASSWORD") ?? urlPass);
  const urlDb = Number(parsed.pathname.replace(/^\//u, ""));
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

  const compareAndSet = readString(config, "VALKEY_COMPARE_AND_SET");
  if (compareAndSet !== "ifeq" && compareAndSet !== "lua") {
    throw new Error("VALKEY_COMPARE_AND_SET: expected one of ifeq|lua");
  }

  const addresses = [
    { host: parsed.hostname, port: parsed.port === "" ? 6379 : Number(parsed.port) },
    ...parsed.searchParams.getAll("addr").map((address) => parseAddress(address)),
  ];
  const masterSet = parsed.searchParams.get("master_set") ?? undefined;
  const topology: ValkeyTopology =
    masterSet !== undefined ? "sentinel" : addresses.length > 1 ? "cluster" : "standalone";
  if (topology === "sentinel" && masterSet === "") {
    throw new Error("VALKEY_URL master_set must name the Sentinel master");
  }
  if (topology === "cluster" && db !== 0) {
    throw new Error("VALKEY_URL: a cluster uses DB 0");
  }

  return {
    topology,
    addresses,
    host: addresses[0]?.host ?? "",
    port: addresses[0]?.port ?? 6379,
    ...(masterSet !== undefined ? { masterSet } : {}),
    compareAndSet,
    username,
    password,
    db,
    tls,
    connectTimeoutMs: readInt(config, "VALKEY_CONNECT_TIMEOUT_MS"),
    commandTimeoutMs: readInt(config, "VALKEY_COMMAND_TIMEOUT_MS"),
    socketTimeoutMs: readInt(config, "VALKEY_SOCKET_TIMEOUT_MS"),
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

function endpointOptions(result: ValkeyBuilderResult): Record<string, unknown> {
  if (result.topology !== "sentinel") return { host: result.host, port: result.port };
  return {
    sentinels: result.addresses,
    name: result.masterSet,
    ...(result.tls === undefined
      ? {}
      : { enableTLSForSentinelMode: true, sentinelTLS: result.tls }),
  };
}

/**
 * Shape the parsed config into the option bag the regular Valkey client
 * expects. Adds `lazyConnect` + `enableOfflineQueue=false`: commands fail
 * fast when disconnected, no silent buffering.
 */
export function toClientOptions(result: ValkeyBuilderResult): Record<string, unknown> {
  return {
    ...endpointOptions(result),
    ...(result.username ? { username: result.username } : {}),
    ...(result.password.isSet ? { password: result.password.expose() } : {}),
    db: result.db,
    ...(result.tls ? { tls: result.tls } : {}),
    connectTimeout: result.connectTimeoutMs,
    commandTimeout: result.commandTimeoutMs,
    // Not for BullMQ either: a blocking command is silence by design.
    ...(result.socketTimeoutMs > 0 ? { socketTimeout: result.socketTimeoutMs } : {}),
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
    ...endpointOptions(result),
    ...(result.username ? { username: result.username } : {}),
    ...(result.password.isSet ? { password: result.password.expose() } : {}),
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
