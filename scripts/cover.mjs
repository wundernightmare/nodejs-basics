#!/usr/bin/env node
/**
 * cover.mjs — coverage per test layer, merged across layers.
 *
 *   node scripts/cover.mjs unit          # vitest project unit        → .cover/unit
 *   node scripts/cover.mjs integration   # vitest project integration → .cover/integration
 *   node scripts/cover.mjs e2e           # spawned api+worker bundles under NODE_V8_COVERAGE + Playwright → .cover/e2e
 *   node scripts/cover.mjs merge [--diff-base <breakdown.json>] [--diff-threshold <pct>]
 *                                        # .cover/* → .cover/merged, coverage-breakdown.json, gate
 *
 * Every layer ends up as an istanbul `coverage-final.json`: vitest writes it
 * directly (provider v8, reporter json); the e2e layer is the raw V8 output
 * of the real processes (Vite bundles), remapped through their source maps
 * to `src/**` by scripts/v8-to-istanbul.mjs (ast-v8-to-istanbul).
 *
 * The merge is LINE-based, on purpose. vitest's statement maps come from the
 * source AST of each file, the e2e layer's from the AST of the bundle mapped
 * back through the source map — statement boundaries and ids differ, so an
 * istanbul key-by-key merge would misattribute hits. Instead: the set of executable lines of every file is
 * what vitest reports (it lists every included file, covered or not), and a
 * line is covered when ANY layer hit it. The e2e layer only contributes hits.
 * Nothing is counted twice; branches / functions are not gated. The result
 * is coverage-merged.lcov (DA records) + a per-package breakdown, gated on
 * scripts/cover.config.mjs — the same thing `just cov-check` and the
 * `coverage` CI job run.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import config from "./cover.config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cover = resolve(root, process.env["COVER_DIR"] ?? config.coverDir);
const layers = ["unit", "integration", "e2e"];

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : dflt;
};

function run(bin, args, env = {}) {
  const r = spawnSync(bin, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function vitestLayer(project) {
  const dir = join(cover, project);
  rmSync(dir, { recursive: true, force: true });
  run("pnpm", ["exec", "vitest", "run", "--project", project, "--coverage", "--passWithNoTests"], {
    COVER_DIR: dir,
  });
}

function e2eLayer() {
  const dir = join(cover, "e2e");
  const raw = join(dir, "v8");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(raw, { recursive: true });
  // The harness spawns the built api + worker (e2e/fixtures/services.ts) with
  // NODE_V8_COVERAGE inherited; Node flushes the counters when the processes
  // exit, which the teardown waits for before this returns.
  if (!process.env["SKIP_BUILD"]) run("pnpm", ["-r", "build"]);
  run("pnpm", ["--filter", "@base/e2e", "exec", "playwright", "test"], {
    E2E_SPAWN: "1",
    NODE_V8_COVERAGE: raw,
  });
  // The raw V8 output of the bundles → istanbul, remapped to src/** through
  // the bundles' source maps (scripts/v8-to-istanbul.mjs).
  run(process.execPath, [
    join(root, "scripts/v8-to-istanbul.mjs"),
    raw,
    join(dir, "coverage-final.json"),
  ]);
}

const pct = (s) => (s.total === 0 ? 100 : (100 * s.covered) / s.total);
const fmt = (n) => `${n.toFixed(1)}%`;
const rel = (file) => relative(root, file).split("\\").join("/");
const pkgOf = (file) => {
  const m = /^((?:packages|apps)\/[^/]+)\//u.exec(rel(file));
  return m ? m[1] : "(root)";
};

/** file → (line → hits) out of an istanbul coverage-final.json. */
function loadLayer(layer) {
  const file = join(cover, layer, "coverage-final.json");
  if (!existsSync(file)) return null;
  const out = new Map();
  for (const [path, fc] of Object.entries(JSON.parse(readFileSync(file, "utf8")))) {
    if (config.exclude.some((re) => re.test(rel(path)))) continue;
    const lines = new Map();
    for (const [id, loc] of Object.entries(fc.statementMap)) {
      const line = loc.start.line;
      lines.set(line, Math.max(lines.get(line) ?? 0, fc.s[id] ?? 0));
    }
    out.set(path, lines);
  }
  return out;
}

function merge() {
  const present = layers.map((l) => [l, loadLayer(l)]).filter(([, m]) => m !== null);
  if (present.length === 0) {
    console.error(`cover.mjs merge: no layer data under ${cover}`);
    process.exit(1);
  }
  for (const l of layers) {
    if (!present.some(([n]) => n === l)) {
      console.log(`${l.padEnd(12)} (no data under ${rel(join(cover, l))} — skipped)`);
    }
  }

  // The universe of executable lines: what the vitest layers report (every
  // included file, covered or not). The e2e layer's line set (from the bundles)
  // is only used for files the vitest layers never saw.
  const universe = new Map();
  const astLayers = present.filter(([n]) => n !== "e2e");
  for (const [, m] of astLayers) {
    for (const [file, lines] of m) {
      const u = universe.get(file) ?? new Set();
      for (const line of lines.keys()) u.add(line);
      universe.set(file, u);
    }
  }
  for (const [n, m] of present) {
    if (n !== "e2e") continue;
    for (const [file, lines] of m) {
      if (!universe.has(file)) universe.set(file, new Set(lines.keys()));
    }
  }

  // Per layer and merged: covered = any hits on a universe line.
  const hits = new Map(); // file → (line → hits) merged
  for (const [name, m] of present) {
    let total = 0;
    let covered = 0;
    for (const [file, u] of universe) {
      const lines = m.get(file);
      for (const line of u) {
        total++;
        const h = lines?.get(line) ?? 0;
        if (h > 0) covered++;
        const acc = hits.get(file) ?? new Map();
        acc.set(line, (acc.get(line) ?? 0) + h);
        hits.set(file, acc);
      }
    }
    console.log(`${name.padEnd(12)} ${fmt(pct({ total, covered }))} lines`);
  }

  // Outputs: lcov (DA records only — line coverage is what is merged), the
  // per-package breakdown (the unit of the ratchet), the totals.
  const out = join(cover, "merged");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const lcov = [];
  const byPkg = new Map();
  let total = 0;
  let covered = 0;
  for (const [file, u] of [...universe.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const lines = hits.get(file) ?? new Map();
    let lf = 0;
    let lh = 0;
    lcov.push(`SF:${rel(file)}`);
    for (const line of [...u].sort((a, b) => a - b)) {
      const h = lines.get(line) ?? 0;
      lcov.push(`DA:${line},${h}`);
      lf++;
      if (h > 0) lh++;
    }
    lcov.push(`LF:${lf}`, `LH:${lh}`, "end_of_record");
    total += lf;
    covered += lh;
    const acc = byPkg.get(pkgOf(file)) ?? { total: 0, covered: 0 };
    acc.total += lf;
    acc.covered += lh;
    byPkg.set(pkgOf(file), acc);
  }
  writeFileSync(join(out, "lcov.info"), lcov.join("\n") + "\n");
  writeFileSync(join(root, "coverage-merged.lcov"), lcov.join("\n") + "\n");
  const breakdown = Object.fromEntries(
    [...byPkg.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, s]) => [k, Number(pct(s).toFixed(2))]),
  );
  writeFileSync(join(root, config.breakdownFile), JSON.stringify(breakdown, null, 2) + "\n");

  const totalPct = pct({ total, covered });
  console.log(
    `\nmerged       ${fmt(totalPct)} lines (${covered}/${total}, ${universe.size} files) → coverage-merged.lcov, ${config.breakdownFile}`,
  );
  for (const [pkg, p] of Object.entries(breakdown)) console.log(`  ${pkg.padEnd(32)} ${fmt(p)}`);

  let failed = false;
  const fail = (msg) => {
    failed = true;
    console.error(`  ✗ ${msg}`);
  };
  if (totalPct < config.threshold.total)
    fail(`total ${fmt(totalPct)} < ${config.threshold.total}%`);
  for (const [pkg, p] of Object.entries(breakdown)) {
    const ov = config.override.find((o) => o.path.test(pkg));
    const min = ov ? ov.threshold : config.threshold.package;
    if (p < min) fail(`${pkg} ${fmt(p)} < ${min}%`);
  }
  const base = flag("--diff-base");
  const diffThreshold = Number(flag("--diff-threshold", "0"));
  if (base && existsSync(base)) {
    const before = JSON.parse(readFileSync(base, "utf8"));
    for (const [pkg, p] of Object.entries(breakdown)) {
      if (pkg in before && before[pkg] - p > diffThreshold) {
        fail(`${pkg} regressed ${fmt(before[pkg])} → ${fmt(p)} (diff threshold ${diffThreshold}%)`);
      }
    }
    console.log(`no-regression check against ${base}: ${failed ? "FAILED" : "ok"}`);
  }
  if (failed) {
    console.error("coverage gate failed");
    process.exit(1);
  }
  console.log("coverage gate ok");
}

switch (cmd) {
  case "unit":
  case "integration":
    vitestLayer(cmd);
    break;
  case "e2e":
    e2eLayer();
    break;
  case "merge":
    merge();
    break;
  default:
    console.error(
      "usage: cover.mjs unit|integration|e2e|merge [--diff-base file] [--diff-threshold pct]",
    );
    process.exit(2);
}
