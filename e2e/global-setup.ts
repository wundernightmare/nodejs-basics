import { SPAWN, startServices } from "./fixtures/services.js";
import { API_ADMIN_URL, API_URL, WORKER_ADMIN_URL } from "./helpers/env.js";

/**
 * Wait for the stack to be reachable before the suite runs. Two modes:
 *
 * - default: the stack is already running (`just stack-up` — the production
 *   images against docker/deps.yml); we only poll until the api's health and
 *   both admin servers answer.
 * - E2E_SPAWN=1: the harness launches the built api + worker itself
 *   (fixtures/services.ts) — the mode `scripts/cover.mjs e2e` uses so the
 *   processes' NODE_V8_COVERAGE counters join the merged coverage.
 */
async function waitFor(url: string, tries = 120): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `timed out waiting for ${url} — is the stack up? (just stack-up, or E2E_SPAWN=1 with just deps)`,
  );
}

/** Poll /readyz until every dependency check (db, valkey) reports healthy. */
async function waitForReady(url: string, tries = 120): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = (await res.json()) as { status?: string };
        if (body.status === "ok" || body.status === "ready") return;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${url} to become ready`);
}

export default async function globalSetup(): Promise<void> {
  if (SPAWN) startServices();
  await waitFor(`${API_URL}/health`);
  await waitFor(`${WORKER_ADMIN_URL}/livez`);
  // Wait for full readiness (db + valkey connected) so the first specs don't
  // race the cache warm-up.
  await waitForReady(`${API_ADMIN_URL}/readyz`);
}
