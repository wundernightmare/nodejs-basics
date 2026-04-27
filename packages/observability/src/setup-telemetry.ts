/**
 * OpenTelemetry SDK bootstrap.
 *
 * MUST be the first import in main.ts so that instrumentation registers
 * before any application modules are loaded:
 *
 *   // apps/api/src/main.ts (very first line)
 *   import { setupTelemetry } from "@base/observability";
 *   export const telemetry = setupTelemetry({ ... });
 *
 * Returns the handle so OtelShutdownService can flush providers on exit.
 *
 * Wires:
 *  - Sentry (optional, no-op if SENTRY_DSN unset)
 *  - Prometheus metrics exporter (server is started by AdminServerService)
 *  - OTLP gRPC trace exporter (OTEL_EXPORTER_OTLP_ENDPOINT, default :4317)
 *  - W3C trace + baggage propagators
 *  - Auto-instrumentation: caller-supplied (Fastify, NestJS, Undici, AWS, ...)
 *  - Default Node.js process metrics
 *  - Pyroscope continuous profiling (optional, gated on PYROSCOPE_SERVER_ADDRESS)
 */
import { hostname } from "node:os";

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
import Pyroscope from "@pyroscope/nodejs";
import * as Sentry from "@sentry/nestjs";

import { registerNodeMetrics } from "./node-metrics.js";
import { TELEMETRY_HANDLE, type TelemetryHandle } from "./setup-telemetry.tokens.js";

export { TELEMETRY_HANDLE, type TelemetryHandle };

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
  const serviceName = options.serviceName ?? process.env["OTEL_SERVICE_NAME"] ?? "app";
  const serviceVersion = options.serviceVersion ?? process.env["npm_package_version"] ?? "0.0.1";

  // ─── Sentry ────────────────────────────────────────────────────────────────
  // Initialise before OTel so Sentry captures startup errors too.
  // - skipOpenTelemetrySetup: we own the OTel SDK lifecycle below; Sentry
  //   must not register its own providers, propagators, or span processors.
  // - tracesSampleRate=0: traces flow via OTel/OTLP, not Sentry.
  // A missing SENTRY_DSN makes Sentry a no-op — safe to call unconditionally.
  Sentry.init({
    dsn: process.env["SENTRY_DSN"],
    environment: process.env["NODE_ENV"] ?? "development",
    release: process.env["npm_package_version"],
    skipOpenTelemetrySetup: true,
    tracesSampleRate: 0,
  });

  // ─── Resource ──────────────────────────────────────────────────────────────
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

  // ─── Pyroscope continuous profiling ───────────────────────────────────────
  // Wall-clock CPU samples shipped to a Pyroscope server. No-op when
  // PYROSCOPE_SERVER_ADDRESS is unset. Init failure is swallowed — telemetry
  // must never break the application.
  let pyroscopeStarted = false;
  const pyroscopeAddress = process.env["PYROSCOPE_SERVER_ADDRESS"];
  if (pyroscopeAddress !== undefined && pyroscopeAddress !== "") {
    try {
      Pyroscope.init({
        serverAddress: pyroscopeAddress,
        appName: serviceName,
        tags: { hostname: hostname() },
      });
      Pyroscope.start();
      pyroscopeStarted = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[setupTelemetry] Failed to start Pyroscope:", err);
    }
  }

  const stopPyroscope = async (): Promise<void> => {
    if (!pyroscopeStarted) return;
    await Pyroscope.stop();
  };

  return { prometheusExporter, meterProvider, tracerProvider, stopPyroscope };
}
