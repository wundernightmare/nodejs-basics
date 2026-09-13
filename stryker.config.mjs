// Mutation testing (StrykerJS) — `pnpm mutate` / `just mutate`, the nightly
// `mutation` CI job. Scoped like the Go sibling's gremlins run: only the pure
// decision logic of @base/resilient-client (backoff, cache, errors, pool, the
// client itself), never the whole workspace — a suite re-run per mutant is
// worth its cost there and noise elsewhere. See README "Mutation testing".
//
// Findings live in reports/mutation/ (gitignored): mutation.html to browse,
// mutation.json for the CI artifact; the clear-text summary goes to stdout.
export default {
  // Stryker's default `@stryker-mutator/*` glob looks next to its own package,
  // which under pnpm's strict layout holds only core's dependencies — name the
  // runner's entry file, resolved from the repo root, instead.
  plugins: ["./node_modules/@stryker-mutator/vitest-runner/dist/src/index.js"],
  testRunner: "vitest",
  // The one root config, with the `unit` project only and no Allure — the
  // config switches on STRYKER_MUTATOR_WORKER (see vitest.config.ts). `dir`
  // narrows test discovery to the package; `related` (default) then runs, per
  // mutant, only the specs that import the mutated file.
  vitest: { configFile: "vitest.config.ts", dir: "packages/resilient-client" },
  mutate: [
    "packages/resilient-client/src/**/*.ts",
    "!**/*.spec.ts",
    // OTel instrument wiring (observable gauges over process stats): no
    // decision logic, no unit test — every mutant would be "no coverage".
    "!packages/resilient-client/src/node-metrics.ts",
  ],
  // Per-test coverage: a mutant is run only against the tests that executed
  // the mutated line in the initial dry run.
  coverageAnalysis: "perTest",
  // Mutate the working tree in place (restored on exit) instead of copying it
  // to .stryker-tmp/sandbox: a sandbox copy has no pnpm node_modules symlinks
  // and no workspace `source` resolution, so nothing would import.
  inPlace: true,
  tempDirName: ".stryker-tmp",
  // vitest does not type-check; the TypeScript checker would only slow the run.
  disableTypeChecks: true,
  reporters: ["clear-text", "progress", "json", "html"],
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  htmlReporter: { fileName: "reports/mutation/mutation.html" },
  // high/low colour the report; `break` fails the run below it — a ratchet
  // like the coverage gate: 56.8 % when introduced (2026-09; backoff 95,
  // cache 86, errors 88, pool 39, client 56), so 50 catches a regression and
  // is raised as survivors are triaged (each one is a missing assertion or
  // dead code), lowered only with a reason in the commit.
  thresholds: { high: 80, low: 60, break: 50 },
};
