/**
 * OpenTelemetry SDK bootstrap.
 *
 * MUST be the first import in main.ts so instrumentation registers before
 * any application modules load. Add or remove library instrumentations here.
 */
import { FastifyOtelInstrumentation } from "@fastify/otel";
import { AwsInstrumentation } from "@opentelemetry/instrumentation-aws-sdk";
import { NestInstrumentation } from "@opentelemetry/instrumentation-nestjs-core";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";

import { setupTelemetry, type TelemetryHandle } from "@base/observability";

export const fastifyOtelInstrumentation = new FastifyOtelInstrumentation({
  requestHook(span, request) {
    const requestId = request.headers["x-request-id"];
    if (requestId !== null && requestId !== undefined) {
      span.setAttribute("http.request.id", String(requestId));
    }
  },
});

export const telemetry: TelemetryHandle = setupTelemetry({
  instrumentations: [
    fastifyOtelInstrumentation,
    new NestInstrumentation(),
    new UndiciInstrumentation(),
    new AwsInstrumentation(),
  ],
});
