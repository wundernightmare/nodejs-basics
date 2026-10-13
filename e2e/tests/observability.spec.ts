import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { createTasksClient } from "@base/contracts";

import { E2E, meta, testCase } from "../fixtures/meta.js";
import { API_ADMIN_URL, API_URL, WORKER_ADMIN_URL } from "../helpers/env.js";

const FEATURE = { ...E2E, feature: "health & observability" };
const ROOT = path.resolve(import.meta.dirname, "../..");

/** Every PromQL expression of the alert rules (inline `expr: …` and `expr: |` blocks). */
function ruleExprs(): string[] {
  const lines = fs.readFileSync(path.join(ROOT, "docker/prometheus/rules.yml"), "utf8").split("\n");
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

/** Every PromQL expression of every provisioned dashboard's panels. */
function dashboardExprs(): string[] {
  const dir = path.join(ROOT, "docker/grafana/dashboards");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      return [...text.matchAll(/"expr":\s*"((?:[^"\\]|\\.)*)"/gu)].map(
        (m) => JSON.parse(`"${m[1] ?? ""}"`) as string,
      );
    });
}

/**
 * The metric names an expression reads: label matchers, `by (…)` groupings
 * and strings removed, then every identifier with an underscore that is not
 * a function call. Broker metrics (redpanda_*) come from the broker.
 * process_open_fds / process_max_fds exist on Linux only — where e2e runs.
 */
function metricNames(expr: string): string[] {
  const bare = expr
    .replaceAll(/"(?:[^"\\]|\\.)*"/gu, "")
    .replaceAll(/\{[^}]*\}/gu, "")
    .replaceAll(/\[[^\]]*\]/gu, "") // range windows ($__rate_interval)
    .replaceAll(/\b(?:by|without|on|ignoring)\s*\([^)]*\)/gu, "");
  return [...bare.matchAll(/\b([a-z_][a-z0-9_]*)\b(?!\s*\()/gu)]
    .map((m) => m[1] ?? "")
    .filter((n) => n.includes("_") && !n.startsWith("redpanda_") && !ON_EVENT_ONLY.has(n));
}

/**
 * Labelled counters that get a series only when their event happens (a failed
 * query); the happy-path traffic below never makes one. Their names are still
 * checked against the registry by packages/observability dashboards.spec.ts.
 */
const ON_EVENT_ONLY = new Set(["db_query_errors_total"]);

test.describe("observability contract", () => {
  test("every app metric the alert rules and the dashboard read is on a live /metrics", async ({
    request,
  }) => {
    await meta(FEATURE);
    await testCase("NB-1052", "an alert or a panel never reads a name the code does not export");
    // Traffic through every path the names come from: HTTP, readiness, the
    // outbox → Kafka → worker → job flow.
    const api = createTasksClient({ baseUrl: API_URL });
    await request.get(`${API_ADMIN_URL}/readyz`);
    await request.get(`${WORKER_ADMIN_URL}/readyz`);
    const created = await api.POST("/tasks", { body: { title: "observability contract" } });
    expect(created.response.status).toBe(201);
    const scrape = async (): Promise<Set<string>> => {
      const texts = await Promise.all(
        [`${API_ADMIN_URL}/metrics`, `${WORKER_ADMIN_URL}/metrics`].map(async (url) =>
          (await request.get(url)).text(),
        ),
      );
      const names = new Set<string>();
      for (const text of texts) {
        for (const line of text.split("\n")) {
          const name = /^([a-z_][a-z0-9_]*)[{ ]/u.exec(line)?.[1];
          if (name !== undefined) names.add(name);
        }
      }
      return names;
    };
    const wanted = [
      ...new Set([...ruleExprs(), ...dashboardExprs()].flatMap((e) => metricNames(e))),
    ];
    expect(wanted.length).toBeGreaterThan(15); // the extraction still finds them
    await expect
      .poll(
        async () => {
          const names = await scrape();
          return wanted.filter((n) => !names.has(n)).toSorted();
        },
        { timeout: 30_000, intervals: [1_000] },
      )
      .toEqual([]);
  });
});
