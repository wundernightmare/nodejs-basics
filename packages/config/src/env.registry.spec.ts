import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { meta, testCase, workspaceRoot } from "@base/testing";

import { parseConfigValue } from "./config.values.js";
import { ENV_REGISTRY } from "./env.registry.js";

/**
 * The registry is only worth something if it is complete: an unregistered key
 * cannot be set from structured YAML, is missing from /admin/config, and is
 * invisible to whoever configures the service. This spec reads the runtime
 * sources and fails on any key they read that the registry does not list.
 */
const root = workspaceRoot();

/** Runtime TypeScript under packages/<pkg>/src and apps/<app>/src (no specs, no generated code, no test harness). */
function runtimeSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && !/\.(spec|gen|d)\.ts$/u.test(entry.name))
        out.push(path);
    }
  };
  for (const group of ["packages", "apps"]) {
    for (const pkg of readdirSync(join(root, group))) {
      if (group === "packages" && pkg === "testing") continue;
      try {
        walk(join(root, group, pkg, "src"));
      } catch {
        // a package without src/
      }
    }
  }
  return out;
}

/** Environment variables that are platform / tooling state, not app configuration. */
const NOT_CONFIG = new Set(["CI"]);

const LITERAL_READS = [
  /\bread[A-Za-z]*\(\s*(?:this\.)?(?:config|processEnv),\s*"([A-Z][A-Z0-9_]+)"/gu,
  /\bconfig\.get(?:OrThrow)?(?:<[^>]*>)?\(\s*"([A-Z][A-Z0-9_]+)"/gu,
  /\bprocess\.env\[\s*"([A-Z][A-Z0-9_]+)"\s*\]/gu,
  /\bprocess\.env\.([A-Z][A-Z0-9_]+)\b/gu,
  /\benvInt\(\s*"([A-Z][A-Z0-9_]+)"/gu,
];

/** `buildRetryPolicy(config, "DATABASE")` reads DATABASE_RETRY_*; the suffixes come from the builders. */
function prefixedReads(sources: Map<string, string>): Map<string, string> {
  const builders = [
    { call: "buildRetryPolicy", file: "packages/resilience/src/retry-policy.builder.ts" },
    { call: "buildCircuitBreaker", file: "packages/resilience/src/circuit-breaker.builder.ts" },
  ];
  const keys = new Map<string, string>();
  for (const { call, file } of builders) {
    const builder = readFileSync(join(root, file), "utf8");
    const suffixes = [...builder.matchAll(/read(?:Num|Bool)\("([A-Z][A-Z0-9_]+)"/gu)].map(
      (m) => m[1],
    );
    expect(suffixes.length, `no suffixes found in ${file}`).toBeGreaterThan(0);
    for (const [path, text] of sources) {
      for (const m of text.matchAll(
        new RegExp(`\\b${call}\\(\\s*config,\\s*"([A-Z][A-Z0-9_]*)"`, "gu"),
      )) {
        for (const suffix of suffixes) keys.set(`${m[1]}_${suffix}`, path);
      }
    }
  }
  return keys;
}

describe("env registry", () => {
  meta({
    epic: "nodejs-basics",
    feature: "config",
    owner: "@team-platform",
    tags: ["config", "unit"],
  });

  const sources = new Map(
    runtimeSources().map((p) => [relative(root, p), readFileSync(p, "utf8")]),
  );
  const read = new Map<string, string>();
  for (const [path, text] of sources) {
    for (const pattern of LITERAL_READS) {
      for (const m of text.matchAll(pattern)) {
        const key = m[1];
        if (key !== undefined && !NOT_CONFIG.has(key) && !read.has(key)) read.set(key, path);
      }
    }
  }
  for (const [key, path] of prefixedReads(sources)) if (!read.has(key)) read.set(key, path);
  const registered = new Set(ENV_REGISTRY.map((e) => e.key));

  it("lists every configuration key the runtime code reads", async () => {
    await testCase("NB-121", "an unregistered key fails the build, with the file that reads it");
    expect(read.size).toBeGreaterThan(50); // the scan itself still finds the readers
    const missing = [...read]
      .filter(([key]) => !registered.has(key))
      .map(([k, p]) => `${k} (${p})`);
    expect(missing).toEqual([]);
  });

  it("registers each key once, with a description and a unique YAML path", async () => {
    await testCase("NB-122", "no duplicate keys or yaml paths");
    const keys = ENV_REGISTRY.map((e) => e.key);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
    const yaml = ENV_REGISTRY.flatMap((e) => (e.yaml === undefined ? [] : [e.yaml]));
    expect(yaml.filter((y, i) => yaml.indexOf(y) !== i)).toEqual([]);
    expect(ENV_REGISTRY.filter((e) => e.description.trim() === "").map((e) => e.key)).toEqual([]);
  });

  it("types every key a typed reader parses, and every default parses as its type", async () => {
    await testCase("NB-968", "readInt on a string-typed key, or a default the loader would reject");
    const READER_TYPE = {
      readInt: "int",
      readNumber: "number",
      readBool: "bool",
      readJson: "json",
    };
    const entry = new Map(ENV_REGISTRY.map((e) => [e.key, e]));
    const mismatched: string[] = [];
    for (const [path, text] of sources) {
      for (const m of text.matchAll(
        /\b(readInt|readNumber|readBool|readJson)\(\s*(?:this\.)?(?:config|processEnv),\s*"([A-Z0-9_]+)"/gu,
      )) {
        const [, reader, key] = m as unknown as [string, keyof typeof READER_TYPE, string];
        const type = entry.get(key)?.type ?? "string";
        if (type !== READER_TYPE[reader])
          mismatched.push(`${reader}(${key}) on a key typed ${type} (${path})`);
      }
    }
    expect(mismatched).toEqual([]);

    const badDefaults = ENV_REGISTRY.flatMap((e) => {
      if (e.default === undefined || e.type === undefined) return [];
      try {
        parseConfigValue({ ...e, type: e.type }, e.default);
        return [];
      } catch (err) {
        return [(err as Error).message];
      }
    });
    expect(badDefaults).toEqual([]);
    expect(
      ENV_REGISTRY.filter((e) => e.type === "enum" && (e.values ?? []).length === 0).map(
        (e) => e.key,
      ),
    ).toEqual([]);
  });

  it("loads the configuration before any other module of an app", async () => {
    await testCase("NB-969", "a module that reads process.env on load sees config.yaml");
    // ESM runs a module's imports, depth first, before its body: main.ts →
    // instrumentation.ts → boot.ts must each be the FIRST import, or some
    // module reads process.env before the loader filled it from config.yaml.
    const firstImport = (file: string): string | undefined =>
      /^import\s+(?:[^"']*\s+from\s+)?["']([^"']+)["'];/mu.exec(sources.get(file) ?? "")?.[1];
    for (const app of ["api", "worker"]) {
      expect(firstImport(`apps/${app}/src/main.ts`), app).toBe("./instrumentation.js");
      expect(firstImport(`apps/${app}/src/instrumentation.ts`), app).toBe("./boot.js");
      expect(firstImport(`apps/${app}/src/boot.ts`), app).toBe("@base/config/loader");
      expect(sources.get(`apps/${app}/src/boot.ts`), app).toMatch(/^loadConfigOrExit\(/mu);
    }
    // ...and the loader imports nothing that reads the environment on load.
    const loaderImports = [
      ...(sources.get("packages/config/src/config.loader.ts") ?? "").matchAll(/from "([^"]+)"/gu),
      ...(sources.get("packages/config/src/config.values.ts") ?? "").matchAll(/from "([^"]+)"/gu),
    ].map((m) => m[1]);
    expect(loaderImports.toSorted((a, b) => String(a).localeCompare(String(b)))).toEqual(
      [
        "./config.values.js",
        "./env.registry.js",
        "./env.registry.js",
        "node:fs",
        "node:path",
        "yaml",
      ].toSorted(),
    );
  });

  it("a `?? fallback` after a typed reader equals the key's registry default", async () => {
    await testCase("NB-980", "code and registry never disagree on a default");
    const defaults = new Map(ENV_REGISTRY.map((e) => [e.key, e.default]));
    const differing: string[] = [];
    for (const [path, text] of sources) {
      for (const m of text.matchAll(
        /\bread(?:Int|Number|Bool|String)\(\s*(?:this\.)?(?:config|processEnv),\s*"([A-Z0-9_]+)"\)\s*\?\?\s*([\w".-]+)/gu,
      )) {
        const [, key = "", fallback = ""] = m;
        const registryDefault = defaults.get(key);
        const code = fallback.replaceAll("_", "").replaceAll('"', "");
        if (registryDefault !== undefined && registryDefault !== code)
          differing.push(`${key}: registry ${registryDefault}, code ${fallback} (${path})`);
      }
    }
    expect(differing).toEqual([]);
  });
});
