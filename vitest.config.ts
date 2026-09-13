import { configDefaults, defineConfig } from "vitest/config";

/**
 * One vitest config for the whole workspace, two projects = two test layers:
 *
 *   unit         {packages,apps}/*\/src/**\/*.spec.ts            `pnpm test`
 *   integration  **\/*.integration.spec.ts (real services)     `pnpm test:integration`
 *
 * Integration suites reach Postgres / Valkey / Redpanda through the same env
 * the app reads (DATABASE_URL, VALKEY_URL, KAFKA_BROKERS — `just deps`);
 * `integration()` from @base/testing skips a suite locally when its service
 * is not configured and fails it on CI. Every test is an Allure test
 * (allure-vitest); results go to ALLURE_RESULTS_DIR (CI points every layer at
 * one directory) or ./allure-results. Coverage per layer is written by
 * scripts/cover.mjs into .cover/<layer> and merged there — see README "Tests".
 */
const resultsDir = process.env["ALLURE_RESULTS_DIR"] ?? "allure-results";

// Under Stryker (`pnpm mutate`) the suite is re-run once per mutant: no Allure
// (it would write one result set per mutant), no integration project. Stryker
// sets STRYKER_MUTATOR_WORKER in the processes that host its vitest runner.
const underStryker = process.env["STRYKER_MUTATOR_WORKER"] !== undefined;

export default defineConfig({
  // Workspace packages export `source` → src/index.ts (what the apps run with
  // `--conditions source` in dev); without it vite would resolve @base/* to
  // the unbuilt dist/ entry.
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"], externalConditions: ["source"] } },
  test: {
    reporters: underStryker
      ? ["dot"]
      : [
          "default",
          [
            "allure-vitest/reporter",
            {
              resultsDir,
              environmentInfo: { runner: "vitest", node: process.version },
              // Bare ids from `testCase("NB-101", …)` become links — sample hosts,
              // point them at your TestOps / tracker.
              links: {
                tms: { urlTemplate: "https://testops.example.internal/project/1/test-cases/%s" },
                issue: { urlTemplate: "https://issues.example.internal/browse/%s" },
              },
            },
          ],
        ],
    setupFiles: underStryker ? [] : ["allure-vitest/setup"],
    // No retries: a flake is reported (Allure), never hidden behind a re-run.
    retry: 0,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
      exclude: [
        "**/*.spec.ts",
        "**/*.d.ts",
        "packages/testing/**", // the harness itself is not a coverage target
        "**/dist/**",
      ],
      // json = istanbul's coverage-final.json, the format scripts/cover.mjs merges.
      reporter: ["text-summary", "json"],
      reportsDirectory: process.env["COVER_DIR"] ?? "coverage",
      reportOnFailure: true,
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.spec.ts", "apps/*/src/**/*.spec.ts"],
          exclude: [...configDefaults.exclude, "**/*.integration.spec.ts"],
        },
      },
      ...(underStryker
        ? []
        : [
            {
              extends: true as const,
              test: {
                name: "integration",
                include: [
                  "packages/*/src/**/*.integration.spec.ts",
                  "apps/*/src/**/*.integration.spec.ts",
                ],
                // Real services on fixed ports: one file at a time.
                fileParallelism: false,
                testTimeout: 30_000,
                hookTimeout: 60_000,
              },
            },
          ]),
    ],
  },
});
