import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "@playwright/test";

import { API_URL } from "./helpers/env.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Playwright config for the nodejs-basics e2e suite — pure API tests (no
 * browser), driving the stack through Playwright's APIRequestContext.
 *
 * The suite runs against the running stack: `just stack-up` (deps + api +
 * worker), then `just e2e`. globalSetup just waits for readiness.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false, // shared singleton services on fixed ports
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: API_URL,
    extraHTTPHeaders: { Accept: "application/json" },
    actionTimeout: 10_000,
  },
  projects: [{ name: "api" }],
  globalSetup: path.resolve(dirname, "global-setup.ts"),
  timeout: 30_000,
});
