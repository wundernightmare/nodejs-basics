/**
 * @base/testing — the harness every vitest suite in the workspace uses.
 * Test-only: it is a devDependency of the packages, never imported by
 * runtime code.
 *
 * - `meta` / `testCase` / `severity`: Allure + TestOps identity (labels, ids, links)
 * - `integration` / `unique`: the integration-layer switch (skip locally, fail on CI)
 * - `captureLogs`: a real pino logger writing into memory
 * - `metricValue`: read a sample out of Prometheus text
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
export { captureLogs, type LogCapture } from "./logs.js";
export { meta, severity, Severity, testCase, type Meta } from "./meta.js";
export { metricValue } from "./metrics.js";
export { propertyRuns } from "./property.js";
export { integration, unique, type Integration, type Service } from "./services.js";
