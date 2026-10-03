import type { IncomingMessage, ServerResponse } from "node:http";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AppLogger, logLevel, pinoLogger } from "@base/logger";

import { AdminServerService } from "./admin-server.service.js";
import type { CrashReportService } from "./crash-report.service.js";
import type { HeapSnapshotService } from "./heap-snapshot.service.js";
import { ReadinessService } from "./readiness.service.js";
import type { TelemetryHandle } from "./setup-telemetry.tokens.js";

const telemetry = {
  prometheusExporter: {
    getMetricsRequestHandler(_req: IncomingMessage, res: ServerResponse) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("# TYPE up gauge\nup 1\n");
    },
  },
} as unknown as TelemetryHandle;

const appLogger = new AppLogger(pinoLogger.child({}, { level: "silent" }));

type Json = Record<string, unknown>;
const json = async (res: Response): Promise<Json> => (await res.json()) as Json;

async function start(opts: { token?: string; withConfig?: boolean } = {}): Promise<{
  admin: AdminServerService;
  readiness: ReadinessService;
  base: string;
}> {
  process.env["ADMIN_PORT"] = "0";
  if (opts.token === undefined) delete process.env["ADMIN_TOKEN"];
  else process.env["ADMIN_TOKEN"] = opts.token;
  const readiness = new ReadinessService([{ name: "db", check: async () => "ok" }], appLogger);
  const admin = new AdminServerService(readiness, telemetry, appLogger, {
    configSnapshot:
      opts.withConfig === false
        ? undefined
        : () => ({
            config: {
              DATABASE_URL: "postgresql://app:app@localhost:5432/app",
              ADMIN_TOKEN: "t",
              COOKIE_SECRET: "",
              PORT: "3000",
            },
            sources: {
              DATABASE_URL: "default",
              ADMIN_TOKEN: "env",
              COOKIE_SECRET: "unset",
              PORT: "env",
            },
          }),
  });
  await admin.onApplicationBootstrap();
  return { admin, readiness, base: `http://127.0.0.1:${admin.port}` };
}

describe("AdminServerService (auth=off)", () => {
  let base: string;
  let admin: AdminServerService;
  let readiness: ReadinessService;

  beforeAll(async () => {
    ({ admin, readiness, base } = await start());
  });
  afterAll(async () => {
    await admin.onApplicationShutdown("test");
  });
  afterEach(() => {
    logLevel.reset();
  });

  it("serves the probes and /metrics", async () => {
    expect(await (await fetch(`${base}/livez`)).json()).toEqual({ status: "ok" });
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ status: "ok" });
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ok", checks: { db: "ok" } });
    expect(await (await fetch(`${base}/metrics`)).text()).toContain("# TYPE up gauge");
  });

  it("/readyz turns 503 not_ready once the gate closes (shutdown)", async () => {
    readiness.setReady(false);
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(503);
    expect((await json(res))["status"]).toBe("not_ready");
    readiness.setReady(true);
  });

  it("GET /version (and /admin/info) describe the build and the process", async () => {
    const body = await (await fetch(`${base}/version`)).json();
    expect(body).toMatchObject({
      service: expect.any(String),
      version: expect.any(String),
      revision: expect.any(String),
      node: process.version,
      started_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
      uptime_seconds: expect.any(Number),
      env: expect.any(String),
    });
    expect(await (await fetch(`${base}/admin/info`)).json()).toMatchObject({
      node: process.version,
    });
  });

  it("GET /admin/config serves the snapshot with secrets redacted", async () => {
    const res = await fetch(`${base}/admin/config`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      config: {
        DATABASE_URL: "postgresql://app:xxxxx@localhost:5432/app",
        ADMIN_TOKEN: "[redacted]",
        COOKIE_SECRET: "",
        PORT: "3000",
      },
      sources: { DATABASE_URL: "default", ADMIN_TOKEN: "env", COOKIE_SECRET: "unset", PORT: "env" },
    });
  });

  it("unknown routes are 404 problem+json carrying the echoed request id", async () => {
    const res = await fetch(`${base}/nope`, { headers: { "x-request-id": "my-req-1" } });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(res.headers.get("x-request-id")).toBe("my-req-1");
    expect(await res.json()).toEqual({
      type: "about:blank",
      title: "Not Found",
      status: 404,
      detail: "no such route",
      instance: "/nope",
      request_id: "my-req-1",
    });
  });

  it("wrong methods are 405 problem+json with Allow; invalid client ids are replaced", async () => {
    const res = await fetch(`${base}/version`, {
      method: "POST",
      headers: { "x-request-id": "bad id" },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
    const id = res.headers.get("x-request-id");
    expect(id).toMatch(/^[0-9A-Z]{8}$/u);
    expect(await res.json()).toMatchObject({
      title: "Method Not Allowed",
      status: 405,
      request_id: id,
    });
  });

  it("PUT/GET/DELETE /admin/log-level end to end, with TTL and strict parsing", async () => {
    const before = await json(await fetch(`${base}/admin/log-level`));
    expect(before).toEqual({
      level: logLevel.base,
      base: logLevel.base,
      expires_at: null,
      max_ttl: "24h",
    });

    const put = await fetch(`${base}/admin/log-level?level=trace&ttl=30m`, { method: "PUT" });
    expect(put.status).toBe(200);
    const changed = await json(put);
    expect(changed).toMatchObject({
      level: "trace",
      base: logLevel.base,
      previous: logLevel.base,
      max_ttl: "24h",
    });
    const remaining = new Date(String(changed["expires_at"])).getTime() - Date.now();
    expect(remaining).toBeGreaterThan(29 * 60_000);
    expect(remaining).toBeLessThanOrEqual(30 * 60_000);
    expect(logLevel.level).toBe("trace");

    // JSON body form; ttl capped at max_ttl (24h)
    const capped = await fetch(`${base}/admin/log-level`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level: "warn", ttl: "99h" }),
    });
    const cappedRemaining =
      new Date(String((await json(capped))["expires_at"])).getTime() - Date.now();
    expect(cappedRemaining).toBeLessThanOrEqual(24 * 3_600_000);
    expect(cappedRemaining).toBeGreaterThan(24 * 3_600_000 - 60_000);

    // bare body (curl --data debug) still works
    const bare = await fetch(`${base}/admin/log-level`, { method: "PUT", body: "debug" });
    expect((await json(bare))["level"]).toBe("debug");

    const typo = await fetch(`${base}/admin/log-level?level=debgu`, { method: "PUT" });
    expect(typo.status).toBe(400);
    expect(typo.headers.get("content-type")).toBe("application/problem+json");
    expect(await json(typo)).toMatchObject({
      status: 400,
      detail: expect.stringContaining('unknown log level "debgu"'),
    });
    expect(logLevel.level).toBe("debug"); // untouched by the rejected request

    const badTtl = await fetch(`${base}/admin/log-level?level=debug&ttl=soon`, { method: "PUT" });
    expect(badTtl.status).toBe(400);

    const del = await fetch(`${base}/admin/log-level`, { method: "DELETE" });
    expect(await json(del)).toMatchObject({
      level: logLevel.base,
      previous: "debug",
      expires_at: null,
    });
  });

  it("a runtime change reverts to the base level when its TTL expires", async () => {
    await fetch(`${base}/admin/log-level?level=trace&ttl=200ms`, { method: "PUT" });
    expect(logLevel.level).toBe("trace");
    await new Promise((r) => setTimeout(r, 350));
    expect(await json(await fetch(`${base}/admin/log-level`))).toMatchObject({
      level: logLevel.base,
      expires_at: null,
    });
  });
});

describe("AdminServerService (auth=bearer)", () => {
  let base: string;
  let admin: AdminServerService;

  beforeAll(async () => {
    ({ admin, base } = await start({ token: "t0k3n", withConfig: false }));
  });
  afterAll(async () => {
    await admin.onApplicationShutdown("test");
    delete process.env["ADMIN_TOKEN"];
    logLevel.reset();
  });

  it("guards the mutations but not the reads", async () => {
    expect((await fetch(`${base}/admin/log-level`)).status).toBe(200);
    expect((await fetch(`${base}/version`)).status).toBe(200);

    const denied = await fetch(`${base}/admin/log-level?level=debug`, { method: "PUT" });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toBe('Bearer realm="admin"');
    expect(await denied.json()).toMatchObject({
      status: 401,
      title: "Unauthorized",
      request_id: expect.any(String),
    });
    expect((await fetch(`${base}/admin/log-level`, { method: "DELETE" })).status).toBe(401);

    const allowed = await fetch(`${base}/admin/log-level?level=debug&ttl=1m`, {
      method: "PUT",
      headers: { authorization: "Bearer t0k3n" },
    });
    expect(allowed.status).toBe(200);
  });

  it("has no /admin/config route without a snapshot function", async () => {
    expect((await fetch(`${base}/admin/config`)).status).toBe(404);
  });
});

describe("AdminServerService (diagnostics routes)", () => {
  let base: string;
  let admin: AdminServerService;
  // What the next capture / report does: a location, null (busy), or a throw.
  let capture: () => Promise<string | null>;
  let report: () => Promise<{ location: string }>;

  beforeAll(async () => {
    process.env["ADMIN_PORT"] = "0";
    delete process.env["ADMIN_TOKEN"];
    const readiness = new ReadinessService([], appLogger);
    const heapSnapshot = { capture: () => capture() } as unknown as HeapSnapshotService;
    const crashReport = {
      writeDiagnosticReport: () => report(),
    } as unknown as CrashReportService;
    admin = new AdminServerService(readiness, telemetry, appLogger, {}, heapSnapshot, crashReport);
    await admin.onApplicationBootstrap();
    base = `http://127.0.0.1:${admin.port}`;
  });
  afterAll(async () => {
    await admin.onApplicationShutdown("test");
  });
  afterEach(() => {
    logLevel.reset();
  });

  it("POST /debug/heapdump: 200 with the location, 409 while busy, 500 problem on failure", async () => {
    capture = () => Promise.resolve("/tmp/x.heapsnapshot");
    const ok = await fetch(`${base}/debug/heapdump`, { method: "POST" });
    expect([ok.status, await json(ok)]).toEqual([
      200,
      { triggered: true, location: "/tmp/x.heapsnapshot" },
    ]);

    capture = () => Promise.resolve(null);
    expect((await fetch(`${base}/debug/heapdump`, { method: "POST" })).status).toBe(409);

    capture = () => Promise.reject(new Error("disk full"));
    const failed = await fetch(`${base}/debug/heapdump`, { method: "POST" });
    expect([failed.status, (await json(failed))["detail"]]).toEqual([500, "disk full"]);
  });

  it("POST /debug/report: 200 with the result, 500 problem on failure", async () => {
    report = () => Promise.resolve({ location: "/tmp/r.json" });
    const ok = await fetch(`${base}/debug/report`, { method: "POST" });
    expect([ok.status, await json(ok)]).toEqual([
      200,
      { triggered: true, location: "/tmp/r.json" },
    ]);

    report = () => Promise.reject(new Error("no space"));
    const failed = await fetch(`${base}/debug/report`, { method: "POST" });
    expect([failed.status, (await json(failed))["detail"]]).toEqual([500, "no space"]);
  });

  it("takes the log level from a form body or a bare one", async () => {
    const form = await fetch(`${base}/admin/log-level`, {
      method: "PUT",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "level=debug&ttl=1m",
    });
    expect((await json(form))["level"]).toBe("debug");

    const bare = await fetch(`${base}/admin/log-level`, { method: "PUT", body: "warn" });
    expect((await json(bare))["level"]).toBe("warn");
  });
});
