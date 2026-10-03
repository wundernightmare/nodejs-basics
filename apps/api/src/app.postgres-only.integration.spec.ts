import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { VALKEY_CLIENT } from "@base/cache";
import { KafkaProducerService } from "@base/kafka";
import { AdminServerService } from "@base/observability";
import { integration, meta, testCase } from "@base/testing";

/**
 * The api with DATABASE_URL alone: no VALKEY_URL, no KAFKA_BROKERS (unset
 * here even when `just test-integration` passes them) — Postgres is all it
 * needs.
 */
const infra = integration("postgres");

describe.skipIf(infra.skip)("apps/api on Postgres alone (integration)", () => {
  meta({
    epic: "nodejs-basics",
    feature: "optional integrations",
    owner: "@team-platform",
    tags: ["api", "integration"],
  });

  let app: NestFastifyApplication;
  let admin: string;
  const pool = new Pool({ connectionString: infra.url("postgres") });

  beforeAll(async () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("VALKEY_") || key.startsWith("KAFKA_"))
        Reflect.deleteProperty(process.env, key);
    }
    process.env["APP_CONFIG_FILE"] = "absent.yaml";
    process.env["ADMIN_PORT"] = "0";
    process.env["LOG_LEVEL"] ??= "warn";
    process.env["NODE_ENV"] ??= "test";
    await import("./instrumentation.js");
    const { createApp } = await import("./app.js");
    app = await createApp();
    await app.init();
    admin = `http://127.0.0.1:${app.get(AdminServerService).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await pool.end();
  });

  it("starts without Valkey and Kafka, ready on Postgres alone", async () => {
    await testCase("NB-1004", "a disabled integration is not wired, not checked, and reported");
    expect(() => app.get<unknown>(VALKEY_CLIENT, { strict: false })).toThrow();
    expect(() => app.get(KafkaProducerService, { strict: false })).toThrow();

    const ready = await fetch(`${admin}/readyz`);
    expect(ready.status).toBe(200);
    expect(((await ready.json()) as { checks: object }).checks).toEqual({ db: "ok" });

    const metrics = await (await fetch(`${admin}/metrics`)).text();
    expect(metrics).toMatch(/^app_integration_enabled\{integration="kafka".*\} 0$/mu);
    expect(metrics).toMatch(/^app_integration_enabled\{integration="valkey".*\} 0$/mu);
  });

  it("keeps Idempotency-Key in Postgres and the event in the outbox", async () => {
    await testCase("NB-1005", "without Valkey and Kafka: replay from Postgres, event kept");
    const key = crypto.randomUUID();
    const create = (): ReturnType<NestFastifyApplication["inject"]> =>
      app.inject({
        method: "POST",
        url: "/tasks",
        payload: { title: "postgres only" },
        headers: { "content-type": "application/json", "idempotency-key": key },
      });

    const first = await create();
    expect(first.statusCode).toBe(201);
    const again = await create();
    expect(again.headers["x-idempotent-replayed"]).toBe("true");
    const { id } = first.json<{ id: string }>();
    expect(again.json<{ id: string }>().id).toBe(id);

    const stored = await pool.query("SELECT 1 FROM idempotency_keys WHERE key LIKE $1", [
      `%${key}%`,
    ]);
    expect(stored.rowCount).toBeGreaterThan(0);
    const events = await pool.query("SELECT 1 FROM outbox WHERE key = $1", [id]);
    expect(events.rowCount).toBe(1);
  });
});
