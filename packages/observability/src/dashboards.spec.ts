import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { meta, testCase, workspaceRoot } from "@base/testing";

import { METRIC_REGISTRY } from "./metrics.registry.js";

/**
 * The provisioned Grafana dashboards and the alert rules are code too: they
 * read only names the registry lists, every app query is scoped by the
 * dashboard's $service / $instance variables (never a hard-coded job), and
 * every rate window is $__rate_interval (it follows the scrape interval; a
 * fixed [1m] breaks at 30 s scrapes and hides spikes at 5 s ones).
 */
const root = workspaceRoot();
const DASHBOARDS = join(root, "docker/grafana/dashboards");

interface Panel {
  title?: string;
  targets?: { expr?: string }[];
  panels?: Panel[];
}

interface Dashboard {
  uid?: string;
  title?: string;
  templating?: { list?: { name?: string }[] };
  links?: unknown[];
  panels?: Panel[];
}

function dashboards(): Map<string, Dashboard> {
  const out = new Map<string, Dashboard>();
  for (const file of readdirSync(DASHBOARDS)
    .filter((f) => f.endsWith(".json"))
    .toSorted()) {
    out.set(file, JSON.parse(readFileSync(join(DASHBOARDS, file), "utf8")) as Dashboard);
  }
  return out;
}

function exprs(d: Dashboard): { panel: string; expr: string }[] {
  const out: { panel: string; expr: string }[] = [];
  const walk = (panels: Panel[] | undefined): void => {
    for (const p of panels ?? []) {
      for (const t of p.targets ?? []) {
        if (t.expr !== undefined) out.push({ panel: p.title ?? "?", expr: t.expr });
      }
      walk(p.panels);
    }
  };
  walk(d.panels);
  return out;
}

/** Every PromQL expression of docker/prometheus/rules.yml (inline and `|` blocks). */
function ruleExprs(): string[] {
  const lines = readFileSync(join(root, "docker/prometheus/rules.yml"), "utf8").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)expr:\s*(.*)$/u.exec(lines[i] ?? "");
    if (!m) continue;
    const [, indent = "", inline = ""] = m;
    if (inline !== "|") {
      out.push(inline);
      continue;
    }
    const block: string[] = [];
    while ((lines[i + 1] ?? "").startsWith(`${indent}  `)) block.push(lines[++i] ?? "");
    out.push(block.join(" "));
  }
  return out;
}

/** Metric selectors in an expression: the name and its `{…}` matchers ("" when none). */
function selectors(expr: string): { name: string; matchers: string }[] {
  const bare = expr
    .replaceAll(/"(?:[^"\\]|\\.)*"/gu, '""')
    .replaceAll(/\b(?:by|without|on|ignoring)\s*\([^)]*\)/gu, "")
    .replaceAll(/\[[^\]]*\]/gu, "");
  const out: { name: string; matchers: string }[] = [];
  for (const m of bare.matchAll(/\b([a-z_][a-z0-9_]*)\b(?!\s*\()(\{[^}]*\})?/gu)) {
    const name = m[1] ?? "";
    if (name === "up" || name.includes("_")) out.push({ name, matchers: m[2] ?? "" });
  }
  // The matchers with their string values, from the original expression.
  const withValues = [...expr.matchAll(/\b([a-z_][a-z0-9_]*)(\{[^}]*\})/gu)];
  return out.map((s) => ({
    name: s.name,
    matchers: withValues.find((w) => w[1] === s.name)?.[2] ?? s.matchers,
  }));
}

/** Registry names plus the series a histogram exports. */
function exportedNames(): Set<string> {
  const names = new Set<string>(["up"]);
  for (const m of METRIC_REGISTRY) {
    names.add(m.name);
    if (m.kind === "Histogram") {
      for (const suffix of ["_bucket", "_sum", "_count"]) names.add(`${m.name}${suffix}`);
    }
  }
  return names;
}

/** Metrics the broker exports (docker/deps.yml turns them on), not the apps. */
const isBrokerMetric = (name: string): boolean => name.startsWith("redpanda_");

describe("Grafana dashboards and alert rules", () => {
  meta({
    epic: "nodejs-basics",
    feature: "observability",
    owner: "@team-platform",
    tags: ["metrics", "dashboards", "unit"],
  });

  it("two dashboards, stable uids, the shared variables and the cross-links", async () => {
    await testCase("NB-1063", "overview + runtime, uid-stable, $datasource/$service/$instance");
    const all = dashboards();
    expect([...all.values()].map((d) => d.uid ?? "").toSorted()).toEqual([
      "nodejs-basics-overview",
      "nodejs-basics-runtime",
    ]);
    for (const [file, d] of all) {
      expect(
        d.templating?.list?.map((v) => v.name),
        file,
      ).toEqual(["datasource", "service", "instance"]);
      expect(d.links?.length, file).toBeGreaterThan(0);
    }
  });

  it("every query: $__rate_interval windows, scoped by $service/$instance, no job selector", async () => {
    await testCase("NB-1064", "a panel never hard-codes a window, a job or skips the variables");
    const problems: string[] = [];
    for (const [file, d] of dashboards()) {
      for (const { panel, expr } of exprs(d)) {
        const where = `${file} "${panel}": ${expr}`;
        if (/\bjob\s*=/u.test(expr)) problems.push(`job selector — ${where}`);
        for (const w of expr.replaceAll(/"(?:[^"\\]|\\.)*"/gu, '""').matchAll(/\[([^\]]+)\]/gu)) {
          if (w[1] !== "$__rate_interval" && w[1] !== "$__range")
            problems.push(`fixed window [${w[1]}] — ${where}`);
        }
        for (const s of selectors(expr)) {
          if (isBrokerMetric(s.name)) continue;
          if (
            !s.matchers.includes('service=~"$service"') ||
            !s.matchers.includes('instance=~"$instance"')
          )
            problems.push(`${s.name} not scoped by $service/$instance — ${where}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("dashboards and alert rules read only names the code exports", async () => {
    await testCase("NB-1065", "a renamed metric fails here, before a dashboard goes blank");
    const known = exportedNames();
    const read = [
      ...[...dashboards().values()].flatMap((d) => exprs(d).map((e) => e.expr)),
      ...ruleExprs(),
    ];
    expect(read.length).toBeGreaterThan(40);
    const unknown = new Set(
      read
        .flatMap((e) => selectors(e).map((s) => s.name))
        .filter((n) => !isBrokerMetric(n) && !known.has(n)),
    );
    expect([...unknown].toSorted()).toEqual([]);
  });

  it("the selector parser sees names, matchers and skips functions, groupings and windows", async () => {
    await testCase("NB-1066", "the lint's PromQL scan");
    expect(
      selectors(
        'histogram_quantile(0.95, sum by (service, le) (rate(a_b_bucket{service=~"$service", x="1"}[$__rate_interval])))',
      ),
    ).toEqual([{ name: "a_b_bucket", matchers: '{service=~"$service", x="1"}' }]);
    expect(selectors("time() - process_start_time_seconds").map((s) => s.name)).toEqual([
      "process_start_time_seconds",
    ]);
    expect(selectors('up{job="api"} == 0')).toEqual([{ name: "up", matchers: '{job="api"}' }]);
  });
});
