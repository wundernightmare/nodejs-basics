import { spawnSync } from "node:child_process";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { E2E, meta, testCase } from "../fixtures/meta.js";
import { API_ENTRY, deps, SPAWN } from "../fixtures/services.js";

const FEATURE = { ...E2E, feature: "startup" };

test.describe("startup", () => {
  test.skip(!SPAWN, "needs the built api (E2E_SPAWN=1)");

  test("an api that cannot listen exits 1 with a fatal line", async () => {
    await meta(FEATURE);
    await testCase("NB-1011", "a port already taken is a clean failed start, not a hang");
    // The spawned api holds :3000; a second one on the same port must give up.
    const second = spawnSync(process.execPath, [API_ENTRY], {
      cwd: path.dirname(path.dirname(API_ENTRY)),
      env: { ...process.env, ...deps, PORT: "3000", ADMIN_PORT: "0" },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(second.status).toBe(1);
    expect(`${second.stdout}${second.stderr}`).toContain("Bootstrap failed");
  });
});
