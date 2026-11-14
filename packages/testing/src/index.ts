/**
 * @base/testing — the harness every vitest suite in the workspace uses.
 * Test-only: it is a devDependency of the packages, never imported by
 * runtime code.
 *
 * - `meta` / `testCase` / `severity`: Allure + TestOps identity (labels, ids, links)
 * - `integration` / `unique`: the integration-layer switch (skip locally, fail on CI)
 * - `captureLogs`: a real pino logger writing into memory
 * - `captureSpans`: the real tracing SDK with an in-memory exporter
 * - `metricValue`: read a sample out of Prometheus text
 * - `captureMetrics`: the real metrics SDK read through the Prometheus exporter
 * - `propertyRuns`: the fast-check budget of a property spec (FC_NUM_RUNS)
 */
export {
  contractPath,
  loadOpenAPI,
  toJsonSchema,
  workspaceRoot,
  type OpenAPIContract,
  type ResolvedOperation,
  type ResponseHeaders,
} from "./contracts.js";
export { logEnvelopeProblems } from "./log-envelope.js";
export { captureLogs, type LogCapture } from "./logs.js";
export { meta, severity, Severity, testCase, type Meta } from "./meta.js";
export { metricValue } from "./metrics.js";
export { captureMetrics, type MetricsCapture } from "./metrics-capture.js";
export { propertyRuns } from "./property.js";
export { captureSpans, type SpanCapture } from "./spans.js";
export {
  integration,
  S3_TEST_CREDENTIALS,
  unique,
  type Integration,
  type Service,
} from "./services.js";
export { pausable, pause, PROXY_PORTS, proxied, proxiedPort } from "./chaos.js";
export { type PgBouncer, type PgBouncerOptions, startPgBouncer } from "./pgbouncer.js";
export {
  type Collector,
  COLLECTOR_CONFIG_PATH,
  COLLECTOR_IMAGE,
  containerRuntimeAvailable,
  type CollectorOptions,
  type Jaeger,
  JAEGER_IMAGE,
  OBSERVABILITY_COMPOSE_PATH,
  startCollector,
  startJaeger,
  type StoredSpan,
  type StoredTrace,
} from "./otel-collector.js";
export type { PausableService, ProxiedService, Proxy, ServiceProxy } from "./chaos.js";
