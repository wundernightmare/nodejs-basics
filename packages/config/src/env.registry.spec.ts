import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { meta, testCase, workspaceRoot } from "@base/testing";

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
  /\bread[A-Za-z]*\(\s*config,\s*"([A-Z][A-Z0-9_]+)"/gu,
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
});
