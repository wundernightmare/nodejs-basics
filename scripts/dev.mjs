#!/usr/bin/env node
/**
 * dev.mjs — watch mode for an app: rebuild on change, restart on rebuild.
 *
 *   cd apps/api && pnpm start:dev            # = node ../../scripts/dev.mjs
 *   cd apps/api && pnpm start:debug          # + --inspect on the app process
 *   just dev | just dev-worker               # from the repo root
 *
 * One Vite watcher, one app process, no extra dependency:
 *   - `vite build --watch` rebuilds dist/main.js whenever a file of the app
 *     OR of any bundled @base/* package changes (they are bundled from src/,
 *     see vite.app.config.ts), in tens of milliseconds.
 *   - after every *successful* build this script restarts the app: SIGTERM
 *     (the app's graceful shutdown runs), wait for exit, spawn again. The
 *     restart is driven by Vite's "built in" line, not by a file watcher on
 *     dist/, so a half-written bundle is never started and a save with a
 *     syntax/type error shows up as a Vite error while the last good build
 *     keeps running.
 * Ctrl-C stops both.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const appDir = process.cwd();
const entry = resolve(appDir, "dist/main.js");
const extraNodeArgs = process.argv.slice(2); // e.g. --inspect, --inspect-brk=9229

const vite = spawn("pnpm", ["exec", "vite", "build", "--watch", "--logLevel", "info"], {
  cwd: appDir,
  stdio: ["ignore", "pipe", "inherit"],
  env: { ...process.env, VITE_WATCH: "1" },
});

let app = null;
let stopping = false;
let generation = 0;

function startApp() {
  const gen = ++generation;
  const child = spawn(process.execPath, ["--enable-source-maps", ...extraNodeArgs, entry], {
    cwd: appDir,
    stdio: "inherit",
    env: process.env,
  });
  app = child;
  child.on("exit", (code, signal) => {
    if (app === child) app = null;
    if (!stopping && gen === generation) {
      console.error(`dev: app exited (${signal ?? code}); waiting for the next build`);
    }
  });
}

function restartApp() {
  const running = app;
  if (!running) {
    startApp();
    return;
  }
  const gen = ++generation; // invalidates the "app exited" message of the old process
  running.once("exit", () => {
    if (!stopping && gen === generation) startApp();
  });
  running.kill("SIGTERM");
}

vite.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  // Vite prints "built in <n>ms" after every successful (re)build.
  if (/built in/.test(text)) restartApp();
});

function stop(signal) {
  if (stopping) return;
  stopping = true;
  app?.kill("SIGTERM");
  vite.kill(signal);
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
vite.on("exit", (code) => {
  if (!stopping) {
    console.error(`dev: vite exited with ${code}`);
    app?.kill("SIGTERM");
    process.exit(code ?? 1);
  }
});
