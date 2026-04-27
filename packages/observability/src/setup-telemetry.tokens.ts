import type { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import type { MeterProvider } from "@opentelemetry/sdk-metrics";
import type { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";

export const TELEMETRY_HANDLE = Symbol("TELEMETRY_HANDLE");

export interface TelemetryHandle {
  prometheusExporter: PrometheusExporter;
  meterProvider: MeterProvider;
  tracerProvider: BasicTracerProvider;
}
