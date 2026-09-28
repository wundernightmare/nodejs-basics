/**
 * OpenTelemetry SDK bootstrap for the worker. MUST be the first import in
 * main.ts. No Fastify here — the worker has no inbound HTTP beyond the admin
 * server; its spans come from the Kafka consumer and the BullMQ processor
 * (@base/kafka traceKafkaMessage, @base/jobs traceJob). See
 * apps/api/src/instrumentation.ts for why patching instrumentations are not
 * used in the bundle.
 */
// Must stay the first import: sets this app's OTEL_SERVICE_NAME default.
import "./service-name.js";

import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";

import { setupTelemetry, type TelemetryHandle } from "@base/observability";

export const telemetry: TelemetryHandle = setupTelemetry({
  instrumentations: [new UndiciInstrumentation()],
});
