import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { meta, testCase, workspaceRoot } from "@base/testing";

import { METRIC_REGISTRY, metricsReference } from "./metrics.registry.js";

/**
 * The registry is what an operator reads instead of the code, so it must be
 * the code's truth: every instrument created in a runtime source is listed,
 * with the same instrument kind, unit and description, and nothing listed is
 * gone from the code.
 */
const root = workspaceRoot();

function runtimeSources(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && !/\.(spec|gen|d)\.ts$/u.test(entry.name))
        out.set(relative(root, path), readFileSync(path, "utf8"));
    }
  };
  for (const group of ["packages", "apps"]) {
    for (const pkg of readdirSync(join(root, group))) {
      if (pkg === "testing") continue;
      try {
        walk(join(root, group, pkg, "src"));
      } catch {
        // a package without src/
      }
    }
  }
  return out;
}

interface Created {
  name: string;
  kind: string;
  unit: string | undefined;
  description: string | undefined;
  file: string;
}

function createdInstruments(sources: Map<string, string>): Created[] {
  const created: Created[] = [];
  for (const [file, text] of sources) {
    for (const m of text.matchAll(
      /\.create(Counter|UpDownCounter|Histogram|ObservableCounter|ObservableGauge|ObservableUpDownCounter|Gauge)(?:<[^>]*>)?\(\s*"([^"]+)"\s*(?:,\s*\{([\s\S]*?)\})?\s*\)/gu,
    )) {
      const opts = m[3] ?? "";
      const description = /description:\s*((?:"(?:[^"\\]|\\.)*"\s*\+?\s*)+)/u.exec(opts)?.[1];
      created.push({
        kind: m[1] ?? "",
        name: m[2] ?? "",
        unit: /unit:\s*"([^"]*)"/u.exec(opts)?.[1],
        description:
          description === undefined
            ? undefined
            : [...description.matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map((d) => d[1]).join(""),
        file,
      });
    }
  }
  return created;
}

describe("metrics registry", () => {
  meta({
    epic: "nodejs-basics",
    feature: "observability",
    owner: "@team-platform",
    tags: ["metrics", "unit"],
  });

  const sources = runtimeSources();
  const created = createdInstruments(sources);

  it("lists every instrument the code creates, exactly as created", async () => {
    await testCase("NB-988", "the metrics reference is the code's truth");
    expect(created.length).toBeGreaterThan(30); // the scan still finds the instruments
    const byName = new Map(METRIC_REGISTRY.map((m) => [m.name, m]));
    const wrong = created.flatMap((c) => {
      const entry = byName.get(c.name);
      if (entry === undefined) return [`${c.name}: not in METRIC_REGISTRY (${c.file})`];
      const got = { kind: c.kind, unit: c.unit, description: c.description };
      const want = { kind: entry.kind, unit: entry.unit, description: entry.description };
      return JSON.stringify(got) === JSON.stringify(want)
        ? []
        : [`${c.name} (${c.file}): code ${JSON.stringify(got)} ≠ registry ${JSON.stringify(want)}`];
    });
    expect(wrong).toEqual([]);
  });

  it("lists nothing the code no longer creates, once, from where it is recorded", async () => {
    await testCase("NB-989", "no stale or duplicate entries");
    const names = METRIC_REGISTRY.map((m) => m.name);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
    const stale = METRIC_REGISTRY.filter(
      (m) => !created.some((c) => c.name === m.name && c.file.startsWith(`${m.source}/`)),
    ).map((m) => `${m.name} (${m.source})`);
    expect(stale).toEqual([]);
  });

  it("names only labels its source records", async () => {
    await testCase("NB-990", "documented labels exist in the recording code");
    const missing = METRIC_REGISTRY.flatMap((m) => {
      const text = [...sources]
        .filter(([f]) => f.startsWith(`${m.source}/`))
        .map(([, t]) => t)
        .join("\n");
      return m.labels
        .filter(
          (l) => !text.includes(`"${l}"`) && !new RegExp(`\\b${l}\\b\\s*[:,}]`, "u").test(text),
        )
        .map((l) => `${m.name}: ${l}`);
    });
    expect(missing).toEqual([]);
  });

  it("prints a line per metric, with when to worry where it matters", async () => {
    await testCase("NB-991", "--metrics-reference");
    const text = metricsReference();
    expect(text).toContain("outbox.dead  ObservableGauge  {message}  no labels");
    expect(text).toContain("watch: > 0: events that will never be published");
    expect(text.split("\n\n")).toHaveLength(METRIC_REGISTRY.length);
  });

  it("imports nothing — an app's boot.ts reads it before any module loads", async () => {
    await testCase("NB-992", "the registry is safe to load first");
    expect(sources.get("packages/observability/src/metrics.registry.ts")).not.toMatch(/^import /mu);
  });
});
