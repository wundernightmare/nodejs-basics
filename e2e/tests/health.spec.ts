import { expect, test } from "@playwright/test";

import { API_ADMIN_URL, WORKER_ADMIN_URL } from "../helpers/env.js";

test.describe("health & observability", () => {
  test("api GET /health is ok @smoke", async ({ request }) => {
    const res = await request.get("/health");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  test("api admin /readyz reports db + valkey healthy", async ({ request }) => {
    const res = await request.get(`${API_ADMIN_URL}/readyz`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.checks).toMatchObject({ db: "ok", valkey: "ok" });
  });

  test("api admin /metrics exposes Prometheus text", async ({ request }) => {
    const res = await request.get(`${API_ADMIN_URL}/metrics`);
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain("# TYPE");
  });

  test("worker admin /livez + /metrics are up", async ({ request }) => {
    expect((await request.get(`${WORKER_ADMIN_URL}/livez`)).status()).toBe(200);
    const metrics = await request.get(`${WORKER_ADMIN_URL}/metrics`);
    expect(metrics.status()).toBe(200);
  });
});
