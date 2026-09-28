/**
 * OpenTelemetry SDK bootstrap.
 *
 * MUST be the first import in main.ts so the providers exist before any
 * application code runs. The app ships as one Vite bundle whose imports are
 * all loaded before this file's body runs, so instrumentations that
 * monkey-patch a module on load (@opentelemetry/instrumentation-pg,
 * -nestjs-core, -aws-sdk, …) never fire here. What works:
 *  - plugins registered on the framework (@fastify/otel below),
 *  - diagnostics_channel subscribers (UndiciInstrumentation: outbound HTTP),
 *  - explicit spans in the @base/* packages (Postgres, Valkey, Kafka, BullMQ).
 */
// Must stay the first import: sets this app's OTEL_SERVICE_NAME default.
import "./service-name.js";

import { FastifyOtelInstrumentation } from "@fastify/otel";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";

import { setupTelemetry, type TelemetryHandle } from "@base/observability";

export const fastifyOtelInstrumentation = new FastifyOtelInstrumentation({
  requestHook(span, request) {
    // HTTP semconv span name `{method} {route}` instead of plain "request".
    const route = request.routeOptions.url;
    if (route !== undefined) span.updateName(`${request.method} ${route}`);
    const requestId = request.headers["x-request-id"];
    if (requestId !== null && requestId !== undefined) {
      span.setAttribute("http.request.id", String(requestId));
    }
  },
});

export const telemetry: TelemetryHandle = setupTelemetry({
  instrumentations: [fastifyOtelInstrumentation, new UndiciInstrumentation()],
});
