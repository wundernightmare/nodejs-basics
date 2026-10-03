/**
 * The coverage gate (`just cov-check`, the `coverage` CI job) — the Node
 * counterpart of the Go sibling's .testcoverage.yml.
 *
 * Runs on the merged profile: the istanbul union of the unit layer (vitest
 * project `unit`), the integration layer (project `integration`, real
 * services) and the e2e layer (the api + worker processes the Playwright
 * harness spawns under NODE_V8_COVERAGE) — see scripts/cover.mjs. One number
 * for the whole pyramid, no line counted twice. The thresholds are a ratchet:
 * raise them when coverage improves, lower only with a reason in the commit.
 */
export default {
  /** Where scripts/cover.mjs writes the per-layer profiles and the merge. */
  coverDir: ".cover",

  /**
   * Per-package breakdown of this run. CI keeps master's copy and hands it to
   * a PR run as `--diff-base coverage-breakdown-base.json --diff-threshold 0`:
   * a change may not lower any package's line coverage at all, whatever the
   * absolute total is. That is the ratchet that stops old code's coverage
   * from hiding new code's.
   */
  breakdownFile: "coverage-breakdown.json",

  /** Line-coverage thresholds, in percent. */
  threshold: {
    total: 70, // unit + integration + e2e merged: 75 % on the first full run (2026-09-13); ratchet up
    package: 0,
  },

  /** Files never counted (regex on the repo-relative path). */
  exclude: [
    /^packages\/testing\//u, // the harness itself
    /\.spec\.ts$/u,
    /\/index\.ts$/u, // re-export barrels
    /^apps\/[^/]+\/src\/instrumentation\.ts$/u, // side-effect-only OTel bootstrap
  ],

  /** Per-package overrides for the parts that are pure logic and must stay high. */
  override: [
    { path: /^packages\/resilient-client$/u, threshold: 80 },
    { path: /^packages\/common$/u, threshold: 70 },
  ],
};
