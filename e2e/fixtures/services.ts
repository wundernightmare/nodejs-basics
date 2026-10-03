/**
 * Spawn-mode fixtures for the e2e harness (E2E_SPAWN=1).
 *
 * By default the suite targets an already-running stack (`just stack-up`:
 * the production images against docker/deps.yml) and only waits for it. With
 * E2E_SPAWN=1 the harness instead launches the *built* api and worker as
 * child processes of the test run — what the coverage layer needs: with
 * NODE_V8_COVERAGE in the environment the processes write their counters on
 * exit, and `scripts/cover.mjs e2e` remaps them to src/**. The backing
 * services still come from docker/deps.yml (`just deps`), reached on
 * localhost. Same idea as the Go sibling's e2e/fixtures/services.ts.
 *
 * Ports match helpers/env.ts defaults: api :3000, api admin :9091, worker
 * admin :9093 (the host ports docker/stack.yml publishes), so the specs need
 * no change between the two modes.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const STATE_FILE = path.join(ROOT, "e2e", ".e2e-state.json");
/** Each spawned service writes its stdout and stderr to <name>.log here. */
export const LOG_DIR = path.join(ROOT, "e2e", "test-results");

export const SPAWN = process.env["E2E_SPAWN"] === "1";

export const API_ENTRY = path.join(ROOT, "apps/api/dist/main.js");

interface ServiceSpec {
  name: string;
  entry: string;
  env: Record<string, string>;
}

export const deps = {
  DATABASE_URL: process.env["DATABASE_URL"] ?? "postgresql://app:app@localhost:5432/app",
  VALKEY_URL: process.env["VALKEY_URL"] ?? "redis://localhost:6379",
  KAFKA_BROKERS: process.env["KAFKA_BROKERS"] ?? "localhost:9092",
  LOG_LEVEL: process.env["E2E_LOG_LEVEL"] ?? "warn",
  NODE_ENV: "production",
};

const SERVICES: ServiceSpec[] = [
  {
    name: "api",
    entry: API_ENTRY,
    env: { ...deps, PORT: "3000", ADMIN_PORT: "9091", OTEL_SERVICE_NAME: "api" },
  },
  {
    name: "worker",
    entry: path.join(ROOT, "apps/worker/dist/main.js"),
    env: {
      ...deps,
      ADMIN_PORT: "9093",
      OTEL_SERVICE_NAME: "worker",
      // Catch events produced before the worker joined the group (as stack.yml does).
      KAFKA_CONSUMER_AUTO_OFFSET_RESET: "earliest",
    },
  },
];

const MIGRATE = path.join(ROOT, "apps/migrate/dist/main.js");

/** Migrate the database (apps/migrate), spawn api + worker from dist/, persist pids for teardown. */
export function startServices(): void {
  const missing = [...SERVICES, { name: "migrate", entry: MIGRATE }]
    .filter((s) => !fs.existsSync(s.entry))
    .map((s) => s.name);
  if (missing.length > 0) {
    throw new Error(
      `missing built entrypoints for ${missing.join(", ")} — run \`pnpm build\` first`,
    );
  }
  fs.mkdirSync(LOG_DIR, { recursive: true });
  // The schema first, as a deployment does it (docker/stack.yml: api waits for migrate).
  const migrated = spawnSync(process.execPath, [MIGRATE], {
    env: { ...process.env, DATABASE_URL: deps.DATABASE_URL },
    encoding: "utf8",
  });
  if (migrated.status !== 0)
    throw new Error(`migrate failed:\n${migrated.stderr}${migrated.stdout}`);
  const children: ChildProcess[] = [];
  for (const svc of SERVICES) {
    const log = fs.openSync(path.join(LOG_DIR, `${svc.name}.log`), "w");
    const child = spawn(process.execPath, ["--enable-source-maps", svc.entry], {
      cwd: path.dirname(path.dirname(path.dirname(svc.entry))), // the app dir (config.yaml lookup)
      env: { ...process.env, ...svc.env },
      stdio: ["ignore", log, log],
    });
    children.push(child);
  }
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({ pids: children.map((c) => c.pid).filter(Boolean) }, null, 2),
  );
}

/**
 * SIGTERM every spawned service and wait for it to exit — the graceful
 * shutdown is what flushes NODE_V8_COVERAGE, so teardown must not return
 * before the processes are gone.
 */
export async function stopServices(): Promise<void> {
  if (!fs.existsSync(STATE_FILE)) return;
  const { pids } = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as { pids: number[] };
  fs.rmSync(STATE_FILE, { force: true });
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  const deadline = Date.now() + 15_000;
  for (const pid of pids) {
    while (alive(pid)) {
      if (Date.now() > deadline) {
        process.kill(pid, "SIGKILL");
        break;
      }
      await delay(100);
    }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
