/**
 * HTTP server instrumentation: metrics + structured access logs.
 *
 * Registered as Fastify lifecycle hooks so the route template is available
 * when the request ends — a raw URL is never a label (every id in a path
 * would be a series).
 *
 * Metrics (the contract shared with golang-basics' libs/httpx):
 *   http_requests_total{method,route,status}        — every request, once
 *   http_request_duration_seconds{method,route}     — Histogram
 *   http_requests_in_flight                         — gauge
 * `method` is one of the nine standard methods or `_OTHER`; `route` is the
 * template, `unmatched` when no route matched (404/405); `status` is the
 * exact code, 499 when the client went away before the response.
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

/** Latency buckets (seconds) shared by the HTTP server and client, db and Kafka. */
export const LATENCY_BUCKETS_SECONDS = [
  0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

const STANDARD_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "CONNECT",
  "OPTIONS",
  "TRACE",
]);

/** The method as a label: a standard one, else `_OTHER` (bounded). */
export function methodLabel(method: string): string {
  return STANDARD_METHODS.has(method) ? method : "_OTHER";
}

/** The status a client that went away before the response is counted with. */
export const CLIENT_CLOSED_REQUEST = 499;

const started = Symbol("http-metrics.started");

type Tracked = FastifyRequest & { [started]?: number | undefined };

export function registerHttpInstrumentation(fastify: FastifyInstance): void {
  const meter = metrics.getMeter("http.server");

  // ─── Metrics instruments ──────────────────────────────────────────────────

  const requests = meter.createCounter("http_requests_total", {
    description: "HTTP requests handled, by method, route template and status.",
  });
  const requestDuration = meter.createHistogram("http_request_duration_seconds", {
    description: "HTTP request latency in seconds, by method and route template.",
    unit: "s",
    advice: { explicitBucketBoundaries: LATENCY_BUCKETS_SECONDS },
  });
  const inFlight = meter.createUpDownCounter("http_requests_in_flight", {
    description: "HTTP requests currently being handled.",
  });

  // Each request ends exactly once: the response went out (onResponse) or
  // the client went away first (onRequestAbort, counted as 499). Whichever
  // comes first counts; a response written after an abort does not count
  // again.
  const end = (request: Tracked, status: number): boolean => {
    const startedAt = request[started];
    if (startedAt === undefined) return false;
    request[started] = undefined;
    const method = methodLabel(request.method);
    const route = request.routeOptions.url ?? "unmatched";
    inFlight.add(-1);
    requests.add(1, { method, route, status: String(status) });
    requestDuration.record((performance.now() - startedAt) / 1000, { method, route });
    return true;
  };

  // ─── Request start ────────────────────────────────────────────────────────
  // Route is NOT resolved yet — log raw URL, track by method only.

  fastify.addHook(
    "onRequest",
    (request: FastifyRequest, _reply: FastifyReply, done: () => void) => {
      (request as Tracked)[started] = performance.now();
      inFlight.add(1);

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
      const route = request.routeOptions.url ?? "unmatched";
      const statusCode = reply.statusCode;
      const durationMs = reply.elapsedTime;
      if (!end(request, statusCode)) {
        done();
        return;
      }

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

  // ─── Client gone before the response ──────────────────────────────────────

  fastify.addHook("onRequestAbort", (request: FastifyRequest, done: () => void) => {
    if (end(request, CLIENT_CLOSED_REQUEST)) {
      request.log.info(
        {
          "http.request.method": request.method,
          "http.route": request.routeOptions.url ?? "unmatched",
          "http.response.status_code": CLIENT_CLOSED_REQUEST,
        },
        "HTTP request aborted by the client",
      );
    }
    done();
  });
}
