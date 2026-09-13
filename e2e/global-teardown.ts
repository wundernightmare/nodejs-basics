import { SPAWN, stopServices } from "./fixtures/services.js";

/** In spawn mode, stop the api + worker the harness started (and wait: coverage flushes on exit). */
export default async function globalTeardown(): Promise<void> {
  if (SPAWN) await stopServices();
}
