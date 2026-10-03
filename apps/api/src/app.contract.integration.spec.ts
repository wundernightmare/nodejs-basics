import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AdminServerService } from "@base/observability";
import { integration, loadOpenAPI, meta, testCase } from "@base/testing";

/**
 * The contract layer: the real application (createApp — the same wiring
 * main.ts listens with) against the real deps, driven through fastify's
 * `inject` (no port), and every exchange validated against the OpenAPI
 * document emitted from api/tsp. A handler that drifts from the contract
 * fails here; what the schema can express (bad input → 400 problem in the
 * right shape, every declared status) Schemathesis generates on top
 * (`just schemathesis`), so this suite owns the behaviour, not the fuzzing.
 */
const infra = integration("postgres", "valkey", "kafka");
const contract = loadOpenAPI("openapi3/tasks.openapi.yaml");
const NUL = String.fromCodePoint(0);
const UNKNOWN_ID = "AAAAAAAAAAAAAAAAAAAAA"; // well-formed, never issued

/** Assert the problem+json envelope every error carries and return the body. */
function problem(res: LightMyRequestResponse): Record<string, unknown> {
  expect(res.headers["content-type"]).toContain("application/problem+json");
  const body = res.json<Record<string, unknown>>();
  expect(body["status"]).toBe(res.statusCode);
  expect(body["errorId"]).toEqual(expect.any(String));
  expect(body["request_id"]).toBe(res.headers["x-request-id"]);
  return body;
}

describe.skipIf(infra.skip)("apps/api HTTP contract (integration)", () => {
  meta({
    epic: "nodejs-basics",
    feature: "tasks API",
    owner: "@team-platform",
    tags: ["api", "contract", "integration"],
  });

  let app: NestFastifyApplication;

  beforeAll(async () => {
    process.env["ADMIN_PORT"] = "0"; // the admin listener picks an ephemeral port
    process.env["LOG_LEVEL"] ??= "warn";
    process.env["NODE_ENV"] ??= "test";
    // Telemetry first, as main.ts does; then the app it instruments.
    await import("./instrumentation.js");
    const { createApp } = await import("./app.js");
    app = await createApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    // Like the e2e harness: wait for /readyz (db + valkey checks) before the
    // first request, instead of asserting readiness again here.
    const admin = app.get(AdminServerService).port;
    for (let i = 0; i < 100; i++) {
      const res = await fetch(`http://127.0.0.1:${admin}/readyz`).catch(() => undefined);
      if (res?.status === 200) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("api did not become ready");
  });

  afterAll(async () => {
    await app?.close();
  });

  /** Send a request and validate the response against the contract before returning it. */
  async function call(
    method: InjectOptions["method"] & string,
    url: string,
    body?: object | string,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> {
    const res = await app.inject({
      method,
      url,
      ...(body !== undefined
        ? { payload: body, headers: { "content-type": "application/json", ...headers } }
        : { headers }),
    });
    contract.validate(method, url, res.statusCode, res.payload, res.headers);
    return res;
  }

  const create = async (title = "contract task"): Promise<{ id: string; version: number }> =>
    (await call("POST", "/tasks", { title })).json<{ id: string; version: number }>();

  it("GET /health answers the HealthStatus shape", async () => {
    await testCase("NB-601", "the health route conforms to the contract");
    const res = await call("GET", "/health");
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe("ok");
  });

  it("POST /tasks creates a task and replays it for a repeated Idempotency-Key", async () => {
    await testCase("NB-602", "create answers 201 Task; the same key replays the same task");
    const key = crypto.randomUUID();
    const payload = { title: "idem", description: "d" };
    const first = await call("POST", "/tasks", payload, { "idempotency-key": key });
    expect(first.statusCode).toBe(201);
    const task = first.json<{ id: string; version: number; description: string }>();
    expect(task.version).toBe(0);
    expect(task.description).toBe("d");

    const again = await call("POST", "/tasks", payload, { "idempotency-key": key });
    expect(again.statusCode).toBe(201);
    expect(again.headers["x-idempotent-replayed"]).toBe("true");
    expect(again.json<{ id: string }>().id).toBe(task.id);

    // The key names that request: another body (or none) under it is a 409, not a replay.
    const other = await call("POST", "/tasks", { title: "other" }, { "idempotency-key": key });
    expect(other.statusCode).toBe(409);
    problem(other);
    const empty = await app.inject({
      method: "POST",
      url: "/tasks",
      headers: { "idempotency-key": key },
    });
    expect(empty.statusCode).toBe(409);
    contract.validate("POST", "/tasks", empty.statusCode, empty.payload, empty.headers);
  });

  it("POST /tasks rejects what the schema rejects with a 400 problem", async () => {
    await testCase("NB-603", "unknown member, empty title, NUL, bad key → 400 problem");
    const bad: Array<[object, Record<string, string>]> = [
      [{ title: "x", bogus: 1 }, {}],
      [{ title: "" }, {}],
      [{ title: `a${NUL}b` }, {}],
      [{ title: "x".repeat(201) }, {}],
      [{ title: "x" }, { "idempotency-key": "not-a-uuid" }],
    ];
    for (const [body, headers] of bad) {
      const res = await call("POST", "/tasks", body, headers);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      problem(res);
    }
    // 200 astral characters are 200 characters (code points), as the contract counts them.
    expect((await call("POST", "/tasks", { title: "😀".repeat(200) })).statusCode).toBe(201);
  });

  it("GET /tasks pages with offset/limit and rejects a malformed query with 400", async () => {
    await testCase(
      "NB-604",
      "the list page conforms; limit=abc, limit=0, limit=1001, offset=-1 → 400",
    );
    const created = await create("listed");
    const page = await call("GET", "/tasks?offset=0&limit=5");
    expect(page.statusCode).toBe(200);
    const body = page.json<{ items: Array<{ id: string }>; total: number }>();
    expect(body.items.length).toBeLessThanOrEqual(5);
    expect(body.total).toBeGreaterThan(0);
    expect(body.items.some((t) => t.id === created.id)).toBe(true);
    expect((await call("GET", "/tasks")).statusCode).toBe(200);
    for (const q of ["limit=abc", "limit=0", "limit=1001", "offset=-1", "offset=1.5"]) {
      const res = await call("GET", `/tasks?${q}`);
      expect(res.statusCode, q).toBe(400);
      problem(res);
    }
  });

  it("GET /tasks/{id} answers the Task or a 404 problem", async () => {
    await testCase("NB-605", "read by id conforms; unknown, malformed and NUL ids are 404");
    const created = await create("read me");
    const res = await call("GET", `/tasks/${created.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ version: number }>().version).toBe(0);
    for (const id of [UNKNOWN_ID, "does-not-exist", "%00", "a".repeat(300)]) {
      const nf = await call("GET", `/tasks/${id}`);
      expect(nf.statusCode, id).toBe(404);
      problem(nf);
    }
  });

  it("PATCH /tasks/{id} updates with optimistic locking: 200 | 400 | 404 | 409", async () => {
    await testCase("NB-606", "update conforms in every declared outcome");
    const created = await create("patch me");
    const id = created.id;
    const ok = await call("PATCH", `/tasks/${id}`, {
      title: "patched",
      description: null,
      expectedVersion: 0,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ version: 1, title: "patched", description: null });

    const stale = await call("PATCH", `/tasks/${id}`, { title: "again", expectedVersion: 0 });
    expect(stale.statusCode).toBe(409);
    problem(stale);
    problem(await call("PATCH", `/tasks/${id}`, { title: "no version" }));
    problem(await call("PATCH", `/tasks/${id}`, { expectedVersion: 1, extra: true }));
    const missing = await call("PATCH", `/tasks/${UNKNOWN_ID}`, { expectedVersion: 0 });
    expect(missing.statusCode).toBe(404);
  });

  it("POST /tasks/{id}/archive is terminal: 200 | 400 | 404 | 409", async () => {
    await testCase("NB-607", "archive conforms in every declared outcome");
    const created = await create("archive me");
    const id = created.id;
    const ok = await call("POST", `/tasks/${id}/archive`, { expectedVersion: 0 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: "ARCHIVED", version: 1 });

    const twice = await call("POST", `/tasks/${id}/archive`, { expectedVersion: 1 });
    expect(twice.statusCode).toBe(409);
    problem(twice);
    problem(await call("POST", `/tasks/${id}/archive`, {}));
    const missing = await call("POST", `/tasks/${UNKNOWN_ID}/archive`, { expectedVersion: 0 });
    expect(missing.statusCode).toBe(404);
  });

  it("an unknown route is a 404 problem, an undeclared method a 405 problem with Allow", async () => {
    await testCase("NB-608", "routing errors are problems in the contract's shape");
    const missing = await app.inject({ method: "GET", url: "/nope" });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["content-type"]).toContain("application/problem+json");
    contract.validateSchema("Problem", missing.json());

    const wrongMethod = await app.inject({ method: "DELETE", url: "/tasks" });
    expect(wrongMethod.statusCode).toBe(405);
    expect(wrongMethod.headers["allow"]).toBe("GET, HEAD, POST");
    expect(wrongMethod.headers["content-type"]).toContain("application/problem+json");
    contract.validateSchema("Problem", wrongMethod.json());

    const created = await create("method check");
    const put = await app.inject({ method: "PUT", url: `/tasks/${created.id}`, payload: {} });
    expect(put.statusCode).toBe(405);
    expect(put.headers["allow"]).toBe("GET, HEAD, PATCH");
  });
});
