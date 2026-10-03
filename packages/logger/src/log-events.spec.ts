import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { meta, testCase, workspaceRoot } from "@base/testing";

import { LOG_EVENTS, logEventsReference } from "./log-events.js";

/**
 * The catalog is the contract for log lines that machines match on: every
 * `event.action` the code writes is in it, nothing in it is gone from the
 * code, and its fields are written by its source.
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

describe("log events catalog", () => {
  meta({
    epic: "nodejs-basics",
    feature: "logging",
    owner: "@team-platform",
    tags: ["logging", "unit"],
  });

  const sources = runtimeSources();
  sources.delete("packages/logger/src/log-events.ts");
  // `"event.action": <expression>` — every string literal in the expression.
  const emitted = new Map<string, string>();
  for (const [file, text] of sources) {
    for (const m of text.matchAll(/"event\.action":\s*([^,\n}]+)/gu)) {
      for (const lit of (m[1] ?? "").matchAll(/"([^"]+)"/gu)) emitted.set(lit[1] ?? "", file);
    }
  }

  it("lists every event.action the code writes, and only those", async () => {
    await testCase("NB-995", "log-based alerts match only documented events");
    const listed = new Set(LOG_EVENTS.map((e) => e.action));
    expect([...emitted.keys()].filter((a) => !listed.has(a))).toEqual([]);
    expect([...listed].filter((a) => !emitted.has(a))).toEqual([]);
    expect(LOG_EVENTS.map((e) => e.action).filter((a, i, all) => all.indexOf(a) !== i)).toEqual([]);
  });

  it("each event is written by its source, with the fields it lists", async () => {
    await testCase("NB-996", "documented fields exist in the code that writes the line");
    const wrong = LOG_EVENTS.flatMap((e) => {
      const file = emitted.get(e.action) ?? "";
      if (!file.startsWith(`${e.source}/`))
        return [`${e.action}: written in ${file}, listed as ${e.source}`];
      const text = sources.get(file) ?? "";
      return e.fields
        .filter((f) => !text.includes(`"${f}"`) && f !== "error.message")
        .map((f) => `${e.action}: ${f}`);
    });
    expect(wrong).toEqual([]);
  });

  it("prints a block per event", async () => {
    await testCase("NB-997", "--log-events-reference");
    const text = logEventsReference();
    expect(text).toContain("config.invalid  fatal  (packages/config)");
    expect(text.split("\n\n")).toHaveLength(LOG_EVENTS.length);
  });

  it("imports nothing — an app's boot.ts reads it before any module loads", async () => {
    await testCase("NB-998", "the catalog is safe to load first");
    expect(readFileSync(join(root, "packages/logger/src/log-events.ts"), "utf8")).not.toMatch(
      /^import /mu,
    );
  });
});
