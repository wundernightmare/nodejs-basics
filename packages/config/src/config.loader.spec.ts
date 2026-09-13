import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configSnapshot, yamlConfigLoader } from "./config.loader.js";

const KEYS = ["PORT", "ADMIN_PORT", "APP_CONFIG_FILE", "DATABASE_URL", "ADMIN_TOKEN"] as const;

describe("yamlConfigLoader + configSnapshot", () => {
  let dir: string;
  const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "config-spec-"));
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("reports env > yaml > default provenance per registered key", () => {
    const file = join(dir, "config.yaml");
    writeFileSync(file, "app:\n  port: 4000\n  admin_port: 9999\n");
    process.env["APP_CONFIG_FILE"] = file;
    process.env["PORT"] = "3333"; // env wins over yaml

    yamlConfigLoader();
    const snap = configSnapshot();

    expect(snap.config["PORT"]).toBe("3333");
    expect(snap.sources["PORT"]).toBe("env");
    expect(snap.config["ADMIN_PORT"]).toBe("9999");
    expect(snap.sources["ADMIN_PORT"]).toBe("yaml");
    expect(snap.config["DATABASE_URL"]).toBe("postgresql://app:app@localhost:5432/app");
    expect(snap.sources["DATABASE_URL"]).toBe("default");
    expect(snap.config["ADMIN_TOKEN"]).toBeNull();
    expect(snap.sources["ADMIN_TOKEN"]).toBe("unset");
  });
});
