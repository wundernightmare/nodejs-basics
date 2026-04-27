/**
 * Shared pino logger configured for:
 *  - ECS (Elastic Common Schema) log format
 *  - OpenTelemetry trace/span context injection via mixin
 *  - Request context (actor.id, tenant.id, http.request.id) injection via mixin
 *  - ECS-compatible Fastify request/response serializers
 *
 * Pass directly to FastifyAdapter so Fastify and NestJS share one logger.
 *
 * ECS field reference: https://www.elastic.co/guide/en/ecs/current/ecs-field-reference.html
 */
import { trace } from "@opentelemetry/api";
import pino from "pino";

import { actorStorage, requestIdStorage, tenantStorage } from "@base/common";

// ─── Static service attributes (set once) ────────────────────────────────────

const serviceName = process.env["OTEL_SERVICE_NAME"] ?? "app";
const serviceVersion = process.env["npm_package_version"] ?? "0.0.1";
const serviceEnvironment = process.env["NODE_ENV"] ?? "development";

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

  // Per-request identity context
  const requestId = requestIdStorage.getStore();
  if (requestId !== null && requestId !== undefined) fields["http.request.id"] = requestId;

  const actor = actorStorage.getStore();
  if (actor !== null && actor !== undefined) fields["actor.id"] = actor;

  const tenant = tenantStorage.getStore();
  if (tenant !== null && tenant !== undefined) fields["tenant.id"] = tenant;

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
    "service.name": serviceName,
    "service.version": serviceVersion,
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
        target: "pino-pretty",
        options: {
          colorize: true,
          singleLine: true,
          messageKey: "message",
          timestampKey: "@timestamp",
          levelKey: "log.level",
          ignore: "process.pid,host.hostname,service.name,service.version,service.environment",
        },
      })
    : undefined;

// ─── Logger instance ──────────────────────────────────────────────────────────

export const pinoLogger = pino(
  {
    messageKey: "message",
    level: process.env["LOG_LEVEL"] ?? (serviceEnvironment === "production" ? "info" : "debug"),
    timestamp: ecsTimestamp,
    mixin: contextMixin,
    formatters,
    serializers,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "*.password",
        "*.secret",
        "*.token",
      ],
      censor: "[REDACTED]",
    },
  },
  prettyTransport,
);
