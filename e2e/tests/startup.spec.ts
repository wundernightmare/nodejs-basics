import { spawnSync } from "node:child_process";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { E2E, meta, testCase } from "../fixtures/meta.js";
import { API_ENTRY, deps, MIGRATE, SPAWN } from "../fixtures/services.js";

const FEATURE = { ...E2E, feature: "startup" };

/** The built migrate bundle against the harness's database. */
const runMigrate = (env: Record<string, string>, ...args: string[]) =>
  spawnSync(process.execPath, [MIGRATE, ...args], {
    env: { ...process.env, DATABASE_URL: deps.DATABASE_URL, ...env },
    encoding: "utf8",
    timeout: 30_000,
  });

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

  test("migrate is configured like the apps: a bad value exits 78 before connecting", async () => {
    await meta(FEATURE);
    await testCase("NB-1018", "the migration job fails fast and readably on a config mistake");
    const bad = runMigrate({ DATABASE_SSL_MODE: "sometimes" });
    expect(bad.status).toBe(78);
    const line = JSON.parse(bad.stderr) as Record<string, string>;
    expect([line["event.action"], line["service.name"]]).toEqual([
      "config.invalid",
      "nodejs-basics-migrate",
    ]);
    expect(line["message"]).toContain('DATABASE_SSL_MODE="sometimes"');
    expect(runMigrate({ DATABASE_PASSWORD_FILE: "/nonexistent" }).status).toBe(78);
    const check = runMigrate({}, "--check-config");
    expect([check.status, check.stdout]).toEqual([0, "configuration is valid\n"]);
  });
});
