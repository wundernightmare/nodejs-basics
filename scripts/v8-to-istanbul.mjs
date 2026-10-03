#!/usr/bin/env node
/**
 * v8-to-istanbul.mjs <raw-dir> <out-file> — the e2e layer's raw V8 coverage
 * (NODE_V8_COVERAGE of the spawned api + worker) → one istanbul
 * coverage-final.json, remapped to src/**.
 *
 * The apps run as Vite bundles (apps/<app>/dist/main.js + source map), so a
 * process's coverage is one script whose ranges have to be mapped back to the
 * dozens of source files bundled into it. That is done with
 * ast-v8-to-istanbul — the converter @vitest/coverage-v8 uses: it walks the
 * bundle's AST (vite's parser), assigns every V8 range to real statements /
 * branches / functions and maps them through the source map. (c8 /
 * v8-to-istanbul remap by line and silently drop the *uncovered* ranges of a
 * bundle — every line came out covered, which is how this file came to be.)
 *
 * Several processes (api, worker) contribute to the same files; their counts
 * are summed per statement — identical bundles have identical maps.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { convert } from "ast-v8-to-istanbul";
import { parse } from "vite";

const [rawDir, outFile] = process.argv.slice(2);
if (!rawDir || !outFile) {
  console.error("usage: v8-to-istanbul.mjs <raw-dir> <out-file>");
  process.exit(2);
}

const root = resolve(import.meta.dirname, "..");
const wanted = (file) =>
  /^(packages|apps)\/[^/]+\/src\/.*\.ts$/u.test(file) &&
  !file.endsWith(".spec.ts") &&
  !file.endsWith(".d.ts") &&
  !file.startsWith("packages/testing/");

const bundles = new Map(); // bundle path → { code, ast, sourceMap }
async function bundle(path) {
  let b = bundles.get(path);
  if (!b) {
    const code = readFileSync(path, "utf8");
    const sourceMap = JSON.parse(readFileSync(`${path}.map`, "utf8"));
    const { program, errors } = await parse(path, code);
    if (errors.length > 0) throw new Error(`${path}: ${errors[0].message}`);
    b = { code, sourceMap, ast: program };
    bundles.set(path, b);
  }
  return b;
}

const merged = {};
function add(fileCov) {
  const key = fileCov.path;
  const cur = merged[key];
  if (!cur) {
    merged[key] = fileCov;
    return;
  }
  for (const k of Object.keys(fileCov.s)) cur.s[k] = (cur.s[k] ?? 0) + fileCov.s[k];
  for (const k of Object.keys(fileCov.f)) cur.f[k] = (cur.f[k] ?? 0) + fileCov.f[k];
  for (const k of Object.keys(fileCov.b)) {
    cur.b[k] = (cur.b[k] ?? fileCov.b[k].map(() => 0)).map((v, i) => v + (fileCov.b[k][i] ?? 0));
  }
}

let scripts = 0;
for (const name of readdirSync(rawDir).filter((n) => n.endsWith(".json"))) {
  const { result } = JSON.parse(readFileSync(join(rawDir, name), "utf8"));
  for (const script of result) {
    if (!script.url.startsWith("file://")) continue;
    const path = fileURLToPath(script.url);
    if (!path.endsWith("/dist/main.js") || !existsSync(`${path}.map`)) continue;
    const { code, ast, sourceMap } = await bundle(path);
    const data = await convert({ code, ast, sourceMap, coverage: script });
    scripts++;
    for (const fileCov of Object.values(data)) {
      const abs = resolve(dirname(path), fileCov.path);
      const rel = abs.startsWith(root + "/") ? abs.slice(root.length + 1) : abs;
      if (!wanted(rel)) continue;
      // oxlint-disable-next-line no-misused-spread -- plain coverage data; a copy with the absolute path is the point
      add({ ...fileCov, path: abs });
    }
  }
}

writeFileSync(outFile, JSON.stringify(merged));
const files = Object.keys(merged);
const stmts = files.flatMap((f) => Object.values(merged[f].s));
const covered = stmts.filter((n) => n > 0).length;
console.log(
  `v8-to-istanbul: ${scripts} bundle script(s) → ${files.length} files, ${covered}/${stmts.length} statements covered → ${outFile}`,
);
