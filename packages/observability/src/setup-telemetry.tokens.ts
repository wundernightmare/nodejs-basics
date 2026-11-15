import type { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import type { MeterProvider } from "@opentelemetry/sdk-metrics";
import type { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";

import type { RetroProcessor } from "./retro/retro-processor.js";

export const TELEMETRY_HANDLE = Symbol("TELEMETRY_HANDLE");

export interface TelemetryHandle {
  prometheusExporter: PrometheusExporter;
  meterProvider: MeterProvider;
  tracerProvider: BasicTracerProvider;
  /**
   * The retroactive sampling buffer; absent when it is off
   * (OTEL_RETRO_BUFFER_MIB=0). A bus between services plugs in here:
   * trigger() and onLocalTrigger().
   */
  retro?: RetroProcessor;
  /** Stops the Pyroscope profiler if it was started. No-op otherwise. */
  stopPyroscope: () => Promise<void>;
}
