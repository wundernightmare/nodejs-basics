import { metrics } from "@opentelemetry/api";
import { PrometheusExporter, PrometheusSerializer } from "@opentelemetry/exporter-prometheus";
import { MeterProvider } from "@opentelemetry/sdk-metrics";

export interface MetricsCapture {
  /** The Prometheus text a scrape of /metrics would return now. */
  scrape(): Promise<string>;
  /** Restore the no-op global meter provider (call in afterAll / afterEach). */
  stop(): Promise<void>;
}

/**
 * Real metrics for a test — a MeterProvider installed as the global one and
 * read through the Prometheus exporter configured like setupTelemetry (no
 * otel_scope_* labels, no target_info), so a test asserts on the exact
 * exposition an operator scrapes. Instruments bind to the provider when they
 * are created: start the capture before constructing the code under test.
 */
export function captureMetrics(): MetricsCapture {
  const exporter = new PrometheusExporter({
    preventServerStart: true,
    withoutScopeInfo: true,
    withoutTargetInfo: true,
  });
  const provider = new MeterProvider({ readers: [exporter] });
  metrics.disable();
  metrics.setGlobalMeterProvider(provider);
  const serializer = new PrometheusSerializer(undefined, false, undefined, true, true);
  return {
    async scrape() {
      const { resourceMetrics } = await exporter.collect();
      return serializer.serialize(resourceMetrics);
    },
    async stop() {
      metrics.disable();
      await provider.shutdown();
    },
  };
}
