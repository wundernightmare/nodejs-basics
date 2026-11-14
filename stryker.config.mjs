// @ts-nocheck
// Mutation testing (StrykerJS) — `pnpm mutate [target…]` / `just mutate`, the
// nightly `mutation` CI job. Scoped like the Go sibling's gremlins runs: only
// decision logic, one target at a time (scripts/mutate.mjs runs them in turn),
// never the whole workspace — a suite re-run per mutant is worth its cost
// there and noise elsewhere. See README "Mutation testing".
//
// Findings live in reports/mutation/<target>.html / .json (gitignored); the
// clear-text summary goes to stdout.
//
// The tree is mutated IN PLACE and restored when Stryker exits. A run that is
// killed leaves every source file instrumented (and stryker-setup-*.js in the
// root): `git checkout -- . && rm -f stryker-setup-*.js && rm -rf .stryker-tmp`.
// scripts/mutate.mjs therefore refuses to start on uncommitted changes.

/**
 * What is mutated. `dir` narrows test discovery to the package; `related`
 * (default) then runs, per mutant, only the specs that import the mutated
 * file. `break` fails the run below that score — a ratchet like the coverage
 * gate: set a little under the score measured when the target was added,
 * raised as survivors are triaged (each one is a missing assertion, dead code
 * or an equivalent mutant), lowered only with a reason in the commit.
 */
export const TARGETS = {
  // 56.8 % when introduced (2026-09; backoff 95, cache 86, errors 88, pool 39,
  // client 56); 66.4 % on 2026-11-14, after the guarantees and real-server suites.
  "resilient-client": {
    dir: "packages/resilient-client",
    mutate: ["packages/resilient-client/src/**/*.ts"],
    break: 61,
  },
  // Measured when added (2026-11-14): 93.5 %.
  "grpc-client": {
    dir: "packages/grpc-client",
    mutate: ["packages/grpc-client/src/**/*.ts"],
    break: 88,
  },
  // 98.0 %: the one survivor is equivalent (`Secret.of(undefined)` is unset either way).
  secret: {
    dir: "packages/common",
    mutate: ["packages/common/src/utils/secret.ts"],
    break: 95,
  },
  // 75.7 %: 111 survivors to triage — the chaos suite covers what the unit layer does not assert.
  "tier-cache": {
    dir: "packages/cache",
    mutate: ["packages/cache/src/tier-cache.ts"],
    break: 70,
  },
  // 87.8 %.
  "rate-limit": {
    dir: "packages/observability",
    mutate: ["packages/observability/src/http-rate-limit.ts"],
    break: 82,
  },
  // Masking of private data, debug subjects, the background guard, sampling, the runtime level.
  logger: {
    dir: "packages/logger",
    mutate: [
      "packages/logger/src/redact.ts",
      "packages/logger/src/debug-subjects.ts",
      "packages/logger/src/background-guard.ts",
      "packages/logger/src/log-sampler.ts",
      "packages/logger/src/log-level.ts",
    ],
    break: 0,
  },
};

const name = process.env["MUTATE_TARGET"] ?? "resilient-client";
const target = TARGETS[name];
if (target === undefined) {
  throw new Error(`unknown mutation target "${name}" (have: ${Object.keys(TARGETS).join(", ")})`);
}

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
  vitest: { configFile: "vitest.config.ts", dir: target.dir },
  // Integration specs are not mutation oracles: the unit layer is.
  mutate: [...target.mutate, "!**/*.spec.ts"],
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
  jsonReporter: { fileName: `reports/mutation/${name}.json` },
  htmlReporter: { fileName: `reports/mutation/${name}.html` },
  // high/low colour the report; `break` is the target's ratchet (above).
  thresholds: { high: 80, low: 60, break: target.break },
};
