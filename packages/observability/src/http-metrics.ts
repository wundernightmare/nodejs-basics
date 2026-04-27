/**
 * HTTP server instrumentation: metrics + structured access logs.
 *
 * Registered as Fastify lifecycle hooks so the route pattern is available
 * in the response hook — raw request URLs alone are useless as metric labels
 * because they produce high-cardinality (every userId in the path is a key).
 *
 * Metrics (OTEL semantic conventions):
 *   http.server.request.duration  — Histogram (ms), per method/route/status
 *   http.server.active_requests   — UpDownCounter, per method
 *
 * Logs (ECS):
 *   "HTTP request received"   — onRequest  (before routing: no route yet)
 *   "HTTP request completed"  — onResponse (route resolved: includes http.route)
 *
 * Requires FastifyAdapter({ disableRequestLogging: true }) so Fastify's own
 * auto-log lines do not double-emit alongside these.
 */
import { metrics } from "@opentelemetry/api";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export function registerHttpInstrumentation(fastify: FastifyInstance): void {
  const meter = metrics.getMeter("http.server");

  // ─── Metrics instruments ──────────────────────────────────────────────────

  const requestDuration = meter.createHistogram("http.server.request.duration", {
    description: "Duration of HTTP server requests",
    unit: "ms",
    advice: {
      // Bucket boundaries in ms matching OTEL recommended s-boundaries × 1000.
      explicitBucketBoundaries: [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000],
    },
  });

  const activeRequests = meter.createUpDownCounter("http.server.active_requests", {
    description: "Number of HTTP server requests currently in flight",
    unit: "{request}",
  });

  // ─── Request start ────────────────────────────────────────────────────────
  // Route is NOT resolved yet — log raw URL, track by method only.

  fastify.addHook(
    "onRequest",
    (request: FastifyRequest, _reply: FastifyReply, done: () => void) => {
      activeRequests.add(1, { "http.request.method": request.method });

      const url = request.url;
      const qIdx = url.indexOf("?");
      request.log.info(
        {
          "http.request.method": request.method,
          "http.request.id": request.id,
          "url.path": qIdx === -1 ? url : url.slice(0, qIdx),
          ...(qIdx !== -1 && { "url.query": url.slice(qIdx + 1) }),
          "client.address": request.ip,
        },
        "HTTP request received",
      );

      done();
    },
  );

  // ─── Request end ──────────────────────────────────────────────────────────
  // Route is resolved — use routeOptions.url as the metric label.

  fastify.addHook(
    "onResponse",
    (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
      const method = request.method;
      const route = request.routeOptions.url ?? "unknown";
      const statusCode = reply.statusCode;
      const durationMs = reply.elapsedTime;

      activeRequests.add(-1, { "http.request.method": method });

      requestDuration.record(durationMs, {
        "http.request.method": method,
        "http.route": route,
        "http.response.status_code": String(statusCode),
      });

      const url = request.url;
      const qIdx = url.indexOf("?");
      request.log.info(
        {
          "http.request.method": method,
          "http.route": route,
          "url.path": qIdx === -1 ? url : url.slice(0, qIdx),
          "http.response.status_code": statusCode,
          "http.response.time_ms": durationMs,
        },
        "HTTP request completed",
      );

      done();
    },
  );
}
