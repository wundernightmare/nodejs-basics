/**
 * OpenTelemetry SDK bootstrap for the worker. MUST be the first import in
 * main.ts so instrumentation registers before any application modules load.
 * No Fastify here — the worker has no inbound HTTP beyond the admin server.
 */
import { NestInstrumentation } from "@opentelemetry/instrumentation-nestjs-core";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";

import { setupTelemetry, type TelemetryHandle } from "@base/observability";

export const telemetry: TelemetryHandle = setupTelemetry({
  instrumentations: [new NestInstrumentation(), new UndiciInstrumentation()],
});
