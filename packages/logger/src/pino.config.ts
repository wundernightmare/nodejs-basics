/**
 * Shared pino logger configured for:
 *  - ECS (Elastic Common Schema) log format
 *  - OpenTelemetry trace/span context injection via mixin
 *  - Request context (http.request.id) injection via mixin
 *  - ECS-compatible Fastify request/response serializers
 *  - A runtime-adjustable level (`logLevel`, see log-level.ts) and per-request
 *    debug logging (withDebugLogging() in @base/common)
 *
 * Pass directly to FastifyAdapter so Fastify and NestJS share one logger.
 *
 * Level handling: pino decides per level *method* — a disabled level is a
 * no-op function, so nothing downstream (mixin, hooks) ever runs for it.
 * To let one request bypass the level, the root logger is therefore pinned
 * at "trace" and the real decision happens in the `logMethod` hook:
 * `logLevel.enabled(level) || isDebugLogging()`. Every child (AppLogger
 * contexts, Fastify's req.log) inherits the hook, so the switch applies
 * everywhere without wrapping. Never set `pinoLogger.level` yourself — use
 * `logLevel.set()`.
 *
 * ECS field reference: https://www.elastic.co/guide/en/ecs/current/ecs-field-reference.html
 */
import { trace } from "@opentelemetry/api";
import pino from "pino";

import { isDebugLogging, requestIdStorage, withDebugLogging } from "@base/common";

import {
  DEFAULT_LOG_LEVEL_MAX_TTL_MS,
  LogLevel,
  type LogLevelName,
  parseDuration,
  parseLogLevelStrict,
} from "./log-level.js";

// ─── Who writes the line ─────────────────────────────────────────────────────

/** The ECS version the log lines follow — `ecs.version` in each one. */
export const ECS_VERSION = "8.11.0";

/**
 * The service, the same in logs, traces, metrics and /version. The version is
 * the build's (SERVICE_VERSION, baked into the image), npm's under `pnpm
 * run`, else "dev".
 */
export const serviceIdentity = {
  name: process.env["OTEL_SERVICE_NAME"] ?? "app",
  version: process.env["SERVICE_VERSION"] ?? process.env["npm_package_version"] ?? "dev",
  environment: process.env["NODE_ENV"] ?? "development",
} as const;
const serviceEnvironment = serviceIdentity.environment;

// ─── ECS timestamp ───────────────────────────────────────────────────────────
//
// Pino's timestamp function must return a raw JSON fragment starting with a
// comma: `,"key":value`. ECS uses "@timestamp" in ISO 8601 format.

function ecsTimestamp(): string {
  return `,"@timestamp":"${new Date().toISOString()}"`;
}

// ─── Context mixin ────────────────────────────────────────────────────────────

function contextMixin(): Record<string, string> {
  const fields: Record<string, string> = {};

  // OTel trace correlation
  const span = trace.getActiveSpan();
  if (span?.isRecording() === true) {
    const ctx = span.spanContext();
    fields["trace.id"] = ctx.traceId;
    fields["span.id"] = ctx.spanId;
    fields["transaction.id"] = ctx.traceId;
  }

  const requestId = requestIdStorage.getStore();
  if (requestId !== null && requestId !== undefined) fields["http.request.id"] = requestId;

  return fields;
}

// ─── ECS error helper ─────────────────────────────────────────────────────────
//
// Spreads ECS error.* fields directly into the root log object.
// Use by spreading into the pino merge-object argument:
//
//   logger.error({ ...ecsError(err), "event.id": id }, "message");

export function ecsError(err: unknown): Record<string, string | undefined> {
  if (!(err instanceof Error)) {
    return { "error.message": String(err) };
  }
  return {
    "error.type": err.constructor?.name ?? err.name,
    "error.message": err.message,
    "error.stack_trace": err.stack,
  };
}

// ─── ECS formatters ──────────────────────────────────────────────────────────

const formatters: pino.LoggerOptions["formatters"] = {
  level: (label: string) => ({ "log.level": label }),
  bindings: (bindings: pino.Bindings) => ({
    "process.pid": bindings["pid"] as number,
    "host.hostname": bindings["hostname"] as string,
    "ecs.version": ECS_VERSION,
    "service.name": serviceIdentity.name,
    "service.version": serviceIdentity.version,
    "service.environment": serviceEnvironment,
  }),
};

// ─── ECS-compatible Fastify serializers ──────────────────────────────────────

const serializers: pino.LoggerOptions["serializers"] = {
  req(req: Record<string, unknown>) {
    const url = typeof req["url"] === "string" ? req["url"] : "";
    const qIdx = url.indexOf("?");
    return {
      "http.request.method": req["method"],
      "http.request.id": req["id"],
      "url.path": qIdx === -1 ? url : url.slice(0, qIdx),
      ...(qIdx !== -1 && { "url.query": url.slice(qIdx + 1) }),
      "client.address": req["remoteAddress"],
      "client.port": req["remotePort"],
    };
  },
  res(res: Record<string, unknown>) {
    return { "http.response.status_code": res["statusCode"] };
  },
  err: pino.stdSerializers.err,
};

// ─── Dev pretty-print transport ───────────────────────────────────────────────
//
// In non-production environments pino-pretty runs in a worker thread (via
// pino.transport) so it never blocks the main event loop.

const prettyTransport =
  serviceEnvironment !== "production"
    ? pino.transport({
        // pino loads a transport in a worker thread and resolves `target` from the
        // file that called pino() — inside an app bundle that is apps/<app>/dist/main.js,
        // so pino-pretty must be resolvable from the app: each app lists it in its
        // devDependencies (dev-only; production logs JSON).
        target: "pino-pretty",
        options: {
          colorize: true,
          singleLine: true,
          messageKey: "message",
          timestampKey: "@timestamp",
          levelKey: "log.level",
          ignore:
            "ecs.version,process.pid,host.hostname,service.name,service.version,service.environment",
        },
      })
    : undefined;

// ─── Runtime log level ────────────────────────────────────────────────────────

function baseLevelFromEnv(): LogLevelName {
  const raw = process.env["LOG_LEVEL"];
  if (raw === undefined || raw === "")
    return serviceEnvironment === "production" ? "info" : "debug";
  return parseLogLevelStrict(raw); // a typo in LOG_LEVEL must fail startup, not fall back
}

function maxTtlFromEnv(): number {
  const raw = process.env["LOG_LEVEL_MAX_TTL"];
  return raw === undefined || raw === "" ? DEFAULT_LOG_LEVEL_MAX_TTL_MS : parseDuration(raw);
}

/**
 * The level in effect for `pinoLogger` and every child. The admin server's
 * /admin/log-level drives it; LOG_LEVEL is the base, LOG_LEVEL_MAX_TTL the cap.
 */
export const logLevel = new LogLevel(baseLevelFromEnv(), {
  maxTtlMs: maxTtlFromEnv(),
  onChange(level, previous, reason) {
    // Explicit changes are logged by their caller (the admin server adds the
    // client); the TTL revert has no caller, so it is logged here. Marked
    // context: this record must land whatever the level was or is.
    if (reason !== "expired") return;
    withDebugLogging(() => {
      pinoLogger.warn(
        { "event.action": "log_level.expired", "log.level.from": previous, "log.level.to": level },
        "Log level reverted to base",
      );
    });
  },
});

/**
 * pino options that enforce `level` in a logMethod hook. Exported so tests can
 * build an isolated logger with the same semantics on a sink of their own.
 */
export function buildPinoOptions(level: LogLevel): pino.LoggerOptions {
  return {
    messageKey: "message",
    // Pinned: the effective level is `level`, enforced in hooks.logMethod (see file header).
    level: "trace",
    hooks: {
      logMethod(args, method, levelValue) {
        if (level.enabled(levelValue) || isDebugLogging()) method.apply(this, args);
      },
    },
    timestamp: ecsTimestamp,
    mixin: contextMixin,
    formatters,
    serializers,
    // Pino paths: `*.password` means "a NESTED `password` one level down" — it
    // matches neither a top-level `password` nor a flat ECS key such as
    // `"user.password"` (one key containing a dot). Flat keys take the bracket
    // form. pino.config.spec.ts checks every entry against a real logger.
    redact: {
      paths: [
        '["user.password"]',
        '["user.token"]',
        '["auth.token"]',
        '["auth.secret"]',
        '["sasl.password"]',
        "password",
        "secret",
        "token",
        "*.password",
        "*.secret",
        "*.token",
        "req.headers.authorization",
        "req.headers.cookie",
      ],
      censor: "[REDACTED]",
    },
  };
}

// ─── Logger instance ──────────────────────────────────────────────────────────

export const pinoLogger = pino(buildPinoOptions(logLevel), prettyTransport);
