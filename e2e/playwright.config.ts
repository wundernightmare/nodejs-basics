import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "@playwright/test";

import { API_URL } from "./helpers/env.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Playwright config for the nodejs-basics e2e suite — pure API tests (no
 * browser), driving the stack through Playwright's APIRequestContext.
 *
 * The suite runs against the running stack (`just stack-up`, then `just e2e`)
 * or, with E2E_SPAWN=1, against the built api + worker the harness spawns
 * itself (`just cov-e2e` — the coverage layer). `pnpm test:smoke` runs the
 * `@smoke` subset (what the container-stack job proves: the images boot and
 * serve).
 *
 * What this layer owns (and vitest does not): real processes, real listeners
 * on real ports, the cross-process flow api → Kafka → worker → BullMQ, the
 * build stamp. Per-route behaviour and error bodies are unit tests; the libs
 * against real services are integration tests — see README "Tests".
 *
 * Results go to Allure (allure-playwright) next to the vitest layers':
 * ALLURE_RESULTS_DIR redirects them, as it does for vitest.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false, // shared singleton services on fixed ports
  forbidOnly: !!process.env["CI"],
  retries: 0, // a flake is reported (Allure), never hidden behind a retry
  workers: 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
    [
      "allure-playwright",
      {
        resultsDir: process.env["ALLURE_RESULTS_DIR"] ?? "allure-results",
        detail: false,
        suiteTitle: false,
        environmentInfo: { layer: "e2e", runner: "playwright" },
        links: {
          tms: { urlTemplate: "https://testops.example.internal/project/1/test-cases/%s" },
          issue: { urlTemplate: "https://issues.example.internal/browse/%s" },
        },
      },
    ],
  ],
  use: {
    baseURL: API_URL,
    extraHTTPHeaders: { Accept: "application/json" },
    actionTimeout: 10_000,
    trace: "retain-on-failure", // request/response log for a failed test, nothing for a green one
  },
  projects: [{ name: "api" }],
  globalSetup: path.resolve(dirname, "global-setup.ts"),
  globalTeardown: path.resolve(dirname, "global-teardown.ts"),
  timeout: 30_000,
  expect: { timeout: 10_000 },
  outputDir: "test-results",
});
