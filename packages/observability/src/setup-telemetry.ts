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
 *  - AsyncLocalStorage context manager (span context across awaits)
 *  - W3C trace + baggage propagators
 *  - Library instrumentations: caller-supplied — only ones that do not patch
 *    modules on load work in the Vite bundle (see apps/api/src/instrumentation.ts)
 *  - Default Node.js process metrics
 *  - Pyroscope continuous profiling (optional, gated on PYROSCOPE_SERVER_ADDRESS)
 */
import { hostname } from "node:os";

import { context, metrics, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { type Instrumentation, registerInstrumentations } from "@opentelemetry/instrumentation";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { AggregationType, MeterProvider } from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import Pyroscope from "@pyroscope/nodejs";
import * as Sentry from "@sentry/nestjs";

import { serviceIdentity } from "@base/logger";

import { registerNodeMetrics } from "./node-metrics.js";
import { TELEMETRY_HANDLE, type TelemetryHandle } from "./setup-telemetry.tokens.js";

export { TELEMETRY_HANDLE, type TelemetryHandle };

/**
 * The semantic-conventions version the resource and span attributes follow —
 * the installed @opentelemetry/semantic-conventions (setup-telemetry.spec.ts
 * keeps the two in step).
 */
export const SEMCONV_SCHEMA_URL = "https://opentelemetry.io/schemas/1.43.0";

/** Meters of library instrumentations whose metrics are not exported. */
export const THIRD_PARTY_METERS = ["@opentelemetry/instrumentation-undici"] as const;

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
  const serviceName = options.serviceName ?? serviceIdentity.name;
  const serviceVersion = options.serviceVersion ?? serviceIdentity.version;

  // ─── Sentry ────────────────────────────────────────────────────────────────
  // Initialise before OTel so Sentry captures startup errors too.
  // - skipOpenTelemetrySetup: we own the OTel SDK lifecycle below; Sentry
  //   must not register its own providers, propagators, or span processors.
  // - tracesSampleRate=0: traces flow via OTel/OTLP, not Sentry.
  // A missing SENTRY_DSN makes Sentry a no-op — safe to call unconditionally.
  Sentry.init({
    dsn: process.env["SENTRY_DSN"],
    environment: serviceIdentity.environment,
    release: serviceVersion,
    skipOpenTelemetrySetup: true,
    tracesSampleRate: 0,
  });

  // ─── Resource ──────────────────────────────────────────────────────────────
  // The pod (hostname) tells instances apart; the schema URL pins the
  // semantic-conventions version the attribute names follow.
  const resource = resourceFromAttributes(
    {
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: serviceVersion,
      "service.instance.id": hostname(),
      "deployment.environment.name": serviceIdentity.environment,
    },
    { schemaUrl: SEMCONV_SCHEMA_URL },
  );

  // ─── Metrics (Prometheus) ──────────────────────────────────────────────────
  // preventServerStart: AdminServerService serves /metrics, not the exporter.
  // The exposition is the metrics contract shared with golang-basics: the
  // instrument names are the Prometheus names (the exporter appends nothing
  // but `_total` to a counter that lacks it, never a unit), and no OTel
  // extras ride along — no otel_scope_* label on every series, no
  // target_info (build_info carries the version; the scrape adds the
  // service and instance labels).
  const prometheusExporter = new PrometheusExporter({
    preventServerStart: true,
    withoutScopeInfo: true,
    withoutTargetInfo: true,
  });

  const meterProvider = new MeterProvider({
    resource,
    readers: [prometheusExporter],
    // Library instrumentations are here for their spans. Their metrics would
    // be a second, differently named and labelled view of what the packages
    // already measure (undici: http_client_request_duration with the target
    // host as a label), so they are dropped.
    views: THIRD_PARTY_METERS.map((meterName) => ({
      meterName,
      aggregation: { type: AggregationType.DROP },
    })),
  });
  metrics.setGlobalMeterProvider(meterProvider);

  // ─── Tracing (OTLP gRPC) ──────────────────────────────────────────────────
  const otlpEndpoint = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ?? "http://localhost:4317";

  const traceExporter = new OTLPTraceExporter({ url: otlpEndpoint });
  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(traceExporter)],
  });
  trace.setGlobalTracerProvider(tracerProvider);

  // ─── Context manager ──────────────────────────────────────────────────────
  // Without one `context.active()` is always empty: every span becomes a root
  // and nothing propagates (NodeTracerProvider.register() would set it; the
  // BasicTracerProvider above does not). @fastify/otel parents its own spans
  // explicitly, which is why its request trees looked fine without it.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

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
  registerNodeMetrics(metrics.getMeter("nodejs"), {
    version: serviceVersion,
    revision: process.env["GIT_COMMIT"] ?? "unknown",
  });

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
