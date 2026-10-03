import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { meta, testCase } from "@base/testing";

/** A fresh module graph: the loader loads once per process. */
function boot(): Promise<typeof import("./config.boot.js")> {
  vi.resetModules();
  return import("./config.boot.js");
}

/** Runs bootConfig with these flags; returns its exit code and output. */
async function run(
  argv: string[],
  references: Parameters<typeof import("./config.boot.js").bootConfig>[0]["references"] = {},
): Promise<{ code?: number; out: string; err: string }> {
  const { bootConfig } = await boot();
  let out = "";
  let err = "";
  // process.exit must stop bootConfig, as the real one does.
  const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw Object.assign(new Error("exit"), { exitCode: code });
  });
  try {
    bootConfig(
      { name: "test-app", defaults: { OTEL_SERVICE_NAME: "test-app" }, references },
      argv,
      (fd, text) => {
        if (fd === 1) out += text;
        else err += text;
      },
    );
    return { out, err };
  } catch (e) {
    const { exitCode } = e as { exitCode?: number };
    return exitCode === undefined ? { out, err } : { code: exitCode, out, err };
  } finally {
    exit.mockRestore();
  }
}

describe("bootConfig — command-line flags", () => {
  meta({
    epic: "nodejs-basics",
    feature: "config",
    owner: "@team-platform",
    tags: ["config", "unit"],
  });

  let dir: string;
  const saved = { ...process.env };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "boot-spec-"));
    process.env["APP_CONFIG_FILE"] = join(dir, "config.yaml");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  it("--help prints the usage and exits 0, whatever the configuration", async () => {
    await testCase("NB-984", "help works even when the configuration is broken");
    writeFileSync(join(dir, "config.yaml"), "databse: {}\n");
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Usage: test-app [option]");
    expect(r.out).toContain("--check-config");
  });

  it("--config-reference lists every setting with its type and default", async () => {
    await testCase("NB-985", "a supporter sees every setting without reading code");
    const r = await run(["--config-reference"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("DATABASE_POOL_MAX  (yaml: database.pool_max)  int 1..  default 10");
    expect(r.out).toContain("OTEL_SERVICE_NAME  (env only)  string  default test-app");
    expect(r.out).toContain(
      "LOG_LEVEL  (yaml: app.log_level)  trace|debug|info|warn|error|fatal|silent",
    );
  });

  it("--check-config exits 0 on a valid configuration and 78 listing the problems", async () => {
    await testCase("NB-986", "validate a deployment's configuration without starting it");
    writeFileSync(join(dir, "config.yaml"), "app:\n  port: 3000\n");
    const ok = await run(["--check-config"]);
    expect([ok.code, ok.out]).toEqual([0, "configuration is valid\n"]);

    writeFileSync(join(dir, "config.yaml"), "databse:\n  url: x\n");
    const bad = await run(["--check-config"]);
    expect(bad.code).toBe(78);
    expect(bad.err).toContain("unknown key databse.url — did you mean database.url?");
  });

  it("an unknown flag is a usage error (64); no flag loads and returns", async () => {
    await testCase("NB-987", "a mistyped flag never starts the service");
    const r = await run(["--chek-config"]);
    expect(r.code).toBe(64);
    expect(r.err).toContain("Usage: test-app");
    expect((await run([])).code).toBeUndefined();
  });

  it("an app adds its own reference flags, listed in --help", async () => {
    await testCase("NB-993", "--metrics-reference and the like come from the app");
    const references = { "things-reference": { help: "every thing", text: () => "thing 1" } };
    const help = await run(["--help"], references);
    expect(help.out).toContain("--things-reference\n                        every thing");
    const r = await run(["--things-reference"], references);
    expect([r.code, r.out]).toEqual([0, "thing 1\n"]);
  });
});
