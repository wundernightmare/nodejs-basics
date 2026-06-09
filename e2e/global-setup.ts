import { API_ADMIN_URL, API_URL, WORKER_ADMIN_URL } from "./helpers/env.js";

/**
 * Wait for the already-running stack (just stack-up) to be reachable before the
 * suite runs. We don't spin the stack here — building the images is slow and the
 * Justfile `e2e` recipe brings it up first — we just poll until the api's health
 * and both admin servers answer.
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
  throw new Error(`timed out waiting for ${url} — is the stack up? (just stack-up)`);
}

/** Poll /readyz until every dependency check (db, valkey) reports healthy. */
async function waitForReady(url: string, tries = 120): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = (await res.json()) as { status?: string };
        if (body.status === "ok") return;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${url} to become ready`);
}

export default async function globalSetup(): Promise<void> {
  await waitFor(`${API_URL}/health`);
  await waitFor(`${WORKER_ADMIN_URL}/livez`);
  // Wait for full readiness (db + valkey connected) so the first specs don't
  // race the cache warm-up.
  await waitForReady(`${API_ADMIN_URL}/readyz`);
}
