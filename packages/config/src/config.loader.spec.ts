import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logEnvelopeProblems, meta, testCase, workspaceRoot } from "@base/testing";

const KEYS = [
  "PORT",
  "ADMIN_PORT",
  "APP_CONFIG_FILE",
  "DATABASE_URL",
  "DATABASE_POOL_MAX",
  "ADMIN_TOKEN",
  "KAFKA_PRODUCER_LINGER_MS",
  "KAFKA_EXTRA_PROPERTIES",
  "LOG_LEVEL",
  "OUTBOX_BATCH_SIZE",
  "HEAP_OOM_POLL_INTERVAL_MS",
  "LOG_LEVEL_MAX_TTL",
  "OTEL_SERVICE_NAME",
  "ALLOWED_ORIGINS",
  "DISABLED_INTEGRATIONS",
] as const;

/** A fresh loader module: it loads once per process, these tests need one per case. */
function loader(): Promise<typeof import("./config.loader.js")> {
  vi.resetModules();
  return import("./config.loader.js");
}

describe("yamlConfigLoader + configSnapshot", () => {
  meta({
    epic: "nodejs-basics",
    feature: "config",
    owner: "@team-platform",
    tags: ["config", "unit"],
  });

  let dir: string;
  const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};
  const file = (yaml: string): void => {
    const path = join(dir, "config.yaml");
    writeFileSync(path, yaml);
    process.env["APP_CONFIG_FILE"] = path;
  };

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

  it("reports env > yaml > default provenance per registered key", async () => {
    await testCase("NB-960", "every key shows its value and where it came from");
    file("app:\n  port: 4000\n  admin_port: 9999\nDATABASE_POOL_MAX: 7\n");
    process.env["PORT"] = "3333"; // env wins over yaml

    const { yamlConfigLoader, configSnapshot } = await loader();
    yamlConfigLoader();
    const snap = configSnapshot();

    expect(snap.config["PORT"]).toBe("3333");
    expect(snap.sources["PORT"]).toBe("env");
    expect(snap.config["ADMIN_PORT"]).toBe("9999");
    expect(snap.sources["ADMIN_PORT"]).toBe("yaml");
    expect(snap.config["DATABASE_POOL_MAX"]).toBe("7"); // a flat registry key
    expect(snap.config["DATABASE_URL"]).toBe("postgresql://app:app@localhost:5432/app");
    expect(snap.sources["DATABASE_URL"]).toBe("default");
    expect(snap.config["ADMIN_TOKEN"]).toBeNull();
    expect(snap.sources["ADMIN_TOKEN"]).toBe("unset");
  });

  it("fails the boot with every problem at once: unknown keys with a hint, bad values", async () => {
    await testCase("NB-961", "a typo or garbage in config.yaml is a startup error, not a default");
    file(
      [
        "databse:",
        "  url: postgresql://elsewhere/db",
        "kafka:",
        "  producer:",
        "    linger_ms: 10ms",
        "app:",
        "  log_level: verbose",
        "outbox:",
        "  batch_size: -5",
        "SOMETHING_ELSE: 1",
      ].join("\n"),
    );
    process.env["PORT"] = "eighty"; // the environment is checked too

    const { yamlConfigLoader } = await loader();
    let message = "";
    try {
      yamlConfigLoader();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message.split("\n").filter((l) => l.startsWith("  - "))).toEqual([
      "  - unknown key databse.url — did you mean database.url?",
      "  - unknown key SOMETHING_ELSE",
      '  - PORT="eighty": expected an integer',
      '  - LOG_LEVEL="verbose": expected one of trace|debug|info|warn|error|fatal|silent (yaml: app.log_level)',
      '  - KAFKA_PRODUCER_LINGER_MS="10ms": expected an integer (yaml: kafka.producer.linger_ms)',
      '  - OUTBOX_BATCH_SIZE="-5": expected an integer >= 1 (yaml: outbox.batch_size)',
    ]);
  });

  it("takes a mapping at a JSON key's path, and loads once per process", async () => {
    await testCase("NB-962", "extra properties as YAML; ConfigModule reuses the boot-time load");
    file("kafka:\n  extra_properties:\n    debug: broker\n");
    const { yamlConfigLoader } = await loader();
    const first = yamlConfigLoader();
    expect(process.env["KAFKA_EXTRA_PROPERTIES"]).toBe('{"debug":"broker"}');

    file("kafka:\n  extra_properties: {}\nbogus: 1\n");
    expect(yamlConfigLoader()).toBe(first);
  });

  it("without a file still applies the defaults and checks the environment", async () => {
    await testCase("NB-963", "env-only containers get the same defaults and validation");
    process.env["APP_CONFIG_FILE"] = join(dir, "absent.yaml");
    process.env["OUTBOX_BATCH_SIZE"] = "0";
    const { yamlConfigLoader } = await loader();
    expect(() => yamlConfigLoader()).toThrow('OUTBOX_BATCH_SIZE="0": expected an integer >= 1');
    expect(process.env["DATABASE_URL"]).toBe("postgresql://app:app@localhost:5432/app");
  });

  it("loads the shipped example config without a problem", async () => {
    await testCase("NB-970", "config.example.yaml stays valid as the registry changes");
    process.env["APP_CONFIG_FILE"] = join(workspaceRoot(), "apps/api/config.example.yaml");
    const { yamlConfigLoader, configSnapshot } = await loader();
    expect(() => yamlConfigLoader()).not.toThrow();
    expect(configSnapshot().sources["DATABASE_URL"]).toBe("yaml");
  });

  it("an entry point exits 78 with one ECS line on a bad configuration", async () => {
    await testCase("NB-971", "boot.ts: a config error is a clean, machine-readable exit");
    file("databse:\n  url: x\n");
    const { loadConfigOrExit } = await loader();
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const written: [number, string][] = [];
    try {
      loadConfigOrExit({}, (fd, text) => {
        written.push([fd, text]);
      });
      expect(exit).toHaveBeenCalledWith(78);
      expect(written.map(([fd]) => fd)).toEqual([2]);
      const line = JSON.parse(written[0]?.[1] ?? "") as Record<string, string>;
      expect(line["log.level"]).toBe("fatal");
      expect(line["message"]).toContain("unknown key databse.url — did you mean database.url?");
      expect(line["event.action"]).toBe("config.invalid");
      expect(logEnvelopeProblems(line)).toEqual([]); // the same envelope as every other line
    } finally {
      exit.mockRestore();
    }
  });

  it("an empty value is no value: it neither shadows config.yaml nor the default", async () => {
    await testCase("NB-981", "KEY= (compose / helm for an unset knob) behaves as unset");
    file('app:\n  port: 4000\n  log_level_max_ttl: ""\n');
    process.env["PORT"] = ""; // would shadow the file
    process.env["HEAP_OOM_POLL_INTERVAL_MS"] = ""; // would reach parseInt("") → NaN
    const { yamlConfigLoader, configSnapshot } = await loader();
    yamlConfigLoader();
    const snap = configSnapshot();
    expect([snap.config["PORT"], snap.sources["PORT"]]).toEqual(["4000", "yaml"]);
    expect([
      snap.config["HEAP_OOM_POLL_INTERVAL_MS"],
      snap.sources["HEAP_OOM_POLL_INTERVAL_MS"],
    ]).toEqual(["10000", "default"]);
    expect([snap.config["LOG_LEVEL_MAX_TTL"], snap.sources["LOG_LEVEL_MAX_TTL"]]).toEqual([
      "24h",
      "default",
    ]);
  });

  it("an app's defaults go over the registry's, an empty value included", async () => {
    await testCase("NB-982", "each app names itself unless OTEL_SERVICE_NAME is set");
    process.env["APP_CONFIG_FILE"] = join(dir, "absent.yaml");
    process.env["OTEL_SERVICE_NAME"] = "";
    const { yamlConfigLoader } = await loader();
    yamlConfigLoader({ defaults: { OTEL_SERVICE_NAME: "my-app" } });
    expect(process.env["OTEL_SERVICE_NAME"]).toBe("my-app");
  });

  it("lets an app run without only the integrations it declares", async () => {
    await testCase(
      "NB-1003",
      "DISABLED_INTEGRATIONS: what the app cannot do without fails the start",
    );
    file("app:\n  disabled_integrations: [Valkey, kafka]\n");
    let { yamlConfigLoader } = await loader();
    expect(() => yamlConfigLoader({ integrations: ["valkey"] })).toThrow(
      "DISABLED_INTEGRATIONS: this app cannot run without kafka (it can without: valkey)",
    );
    ({ yamlConfigLoader } = await loader());
    expect(() => yamlConfigLoader({ integrations: ["valkey", "kafka"] })).not.toThrow();
    const { integrationEnabled } = await import("./integrations.js");
    expect([integrationEnabled("valkey"), integrationEnabled("kafka")]).toEqual([false, false]);

    process.env["DISABLED_INTEGRATIONS"] = "kafak";
    ({ yamlConfigLoader } = await loader());
    expect(() => yamlConfigLoader({ integrations: ["kafka"] })).toThrow(
      'unknown integration "kafak" (known: valkey, kafka)',
    );
  });

  it("joins a YAML list into the comma-separated value the code splits", async () => {
    await testCase("NB-979", "list-valued settings can be written as YAML sequences");
    file("app:\n  allowed_origins:\n    - https://a.example\n    - https://b.example\n");
    const { yamlConfigLoader } = await loader();
    yamlConfigLoader();
    expect(process.env["ALLOWED_ORIGINS"]).toBe("https://a.example,https://b.example");
  });
});
