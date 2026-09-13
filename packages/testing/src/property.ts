/**
 * The budget of a property test (fast-check): how many generated cases each
 * property draws. Property specs (`*.prop.spec.ts`) are the workspace's fuzz
 * layer — the Node analogue of the Go sibling's `Fuzz*` targets — and run in
 * the `unit` project with 100 cases per property, cheap enough for every
 * `pnpm test`. `pnpm fuzz` (the nightly `fuzz` CI job) sets FC_NUM_RUNS=5000
 * for the deep run, the way FUZZTIME stretches `go test -fuzz`.
 *
 *   fc.assert(fc.property(arb, (x) => { … }), { numRuns: propertyRuns() });
 *
 * Packages that do not depend on @base/testing inline the same rule.
 */
export function propertyRuns(): number {
  const raw = process.env["FC_NUM_RUNS"];
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 100;
}
