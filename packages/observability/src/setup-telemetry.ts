/**
 * OpenTelemetry SDK bootstrap.
 *
 * MUST be the first import in main.ts so that instrumentation registers
 * before any application modules are loaded:
 *
 *   // apps/api/src/main.ts (very first line)
 *   import { setupTelemetry } from "@base/observability";
 *   const telemetry = setupTelemetry();
 *
 * Returns the providers so the OtelShutdownService can flush them on exit.
 *
 * Wires:
 *  - Prometheus metrics exporter (server is started by AdminServerService)
 *  - OTLP gRPC trace exporter (OTEL_EXPORTER_OTLP_ENDPOINT, default :4317)
 *  - W3C trace + baggage propagators
 *  - Auto-instrumentation: Fastify, NestJS, Undici, AWS SDK
 *  - Default Node.js process metrics
 */
import { metrics, propagation, trace } from "@opentelemetry/api";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { type Instrumentation, registerInstrumentations } from "@opentelemetry/instrumentation";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

import { registerNodeMetrics } from "./node-metrics.js";

export interface TelemetryHandle {
  prometheusExporter: PrometheusExporter;
  meterProvider: MeterProvider;
  tracerProvider: BasicTracerProvider;
}

export interface SetupTelemetryOptions {
  serviceName?: string;
  serviceVersion?: string;
  /**
   * OpenTelemetry library instrumentations to register. Pass instances of
   * @opentelemetry/instrumentation-* libraries.
   */
  instrumentations?: Instrumentation[];
}

export function setupTelemetry(options: SetupTelemetryOptions = {}): TelemetryHandle {
  const serviceName =
    options.serviceName ?? process.env["OTEL_SERVICE_NAME"] ?? "app";
  const serviceVersion =
    options.serviceVersion ?? process.env["npm_package_version"] ?? "0.0.1";

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: serviceVersion,
  });

  // ─── Metrics (Prometheus) ──────────────────────────────────────────────────
  // preventServerStart: AdminServerService serves /metrics, not the exporter.
  const prometheusExporter = new PrometheusExporter({ preventServerStart: true });

  const meterProvider = new MeterProvider({
    resource,
    readers: [prometheusExporter],
  });
  metrics.setGlobalMeterProvider(meterProvider);

  // ─── Tracing (OTLP gRPC) ──────────────────────────────────────────────────
  const otlpEndpoint =
    process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ??
    process.env["OTLP_ENDPOINT"] ??
    "http://localhost:4317";

  const traceExporter = new OTLPTraceExporter({ url: otlpEndpoint });
  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(traceExporter)],
  });
  trace.setGlobalTracerProvider(tracerProvider);

  // ─── W3C propagation ──────────────────────────────────────────────────────
  propagation.setGlobalPropagator(
    new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
    }),
  );

  // ─── Library instrumentations (caller-supplied) ───────────────────────────
  if (options.instrumentations && options.instrumentations.length > 0) {
    registerInstrumentations({
      tracerProvider,
      meterProvider,
      instrumentations: options.instrumentations,
    });
  }

  // ─── Default Node.js process metrics ──────────────────────────────────────
  registerNodeMetrics(metrics.getMeter("nodejs"));

  return { prometheusExporter, meterProvider, tracerProvider };
}
