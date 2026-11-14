// @ts-nocheck
// pnpm mutate [target…] — StrykerJS over the mutation targets of
// stryker.config.mjs, one after another (each is a run of its own: its own
// package, its own threshold, its own report). No arguments = every target.
//
// The exit code is the worst of the runs: one target under its threshold
// fails the command after the others have still been measured.
import { spawnSync } from "node:child_process";

import { TARGETS } from "../stryker.config.mjs";

const asked = process.argv.slice(2);
const unknown = asked.filter((name) => !(name in TARGETS));
if (unknown.length > 0) {
  console.error(`unknown target: ${unknown.join(", ")} (have: ${Object.keys(TARGETS).join(", ")})`);
  process.exit(2);
}

// A killed run leaves the tree instrumented, and the way back is `git checkout`:
// that must not cost anyone their uncommitted work.
const dirty = spawnSync("git", ["status", "--porcelain", "--", "packages", "apps"], {
  encoding: "utf8",
}).stdout.trim();
if (dirty !== "" && process.env["MUTATE_DIRTY"] !== "1") {
  console.error(
    "mutate: uncommitted changes under packages/ or apps/. Stryker mutates the tree in place; " +
      "a run that is killed is undone with `git checkout`. Commit first, or set MUTATE_DIRTY=1.",
  );
  process.exit(2);
}

let failed = 0;
for (const name of asked.length > 0 ? asked : Object.keys(TARGETS)) {
  console.log(`\n=== mutation target: ${name} ===`);
  const run = spawnSync("pnpm", ["exec", "stryker", "run"], {
    stdio: "inherit",
    env: { ...process.env, MUTATE_TARGET: name },
  });
  if (run.status !== 0) failed += 1;
}
process.exit(failed === 0 ? 0 : 1);
