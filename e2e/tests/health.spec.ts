import { expect, test } from "@playwright/test";

import { E2E, meta, testCase } from "../fixtures/meta.js";
import { API_ADMIN_URL, WORKER_ADMIN_URL } from "../helpers/env.js";

const FEATURE = { ...E2E, feature: "health & observability" };

test.describe("health & observability", () => {
  test("api GET /health is ok @smoke", async ({ request }) => {
    await meta(FEATURE);
    await testCase("NB-501", "the api process is up and serves its public health");
    const res = await request.get("/health");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  test("api admin /readyz reports db + valkey healthy", async ({ request }) => {
    await meta(FEATURE);
    await testCase("NB-502", "readiness turns green only with every dependency connected");
    const res = await request.get(`${API_ADMIN_URL}/readyz`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.checks).toMatchObject({ db: "ok", valkey: "ok" });
  });

  test("api admin /metrics exposes Prometheus text", async ({ request }) => {
    await meta(FEATURE);
    await testCase("NB-503", "the api is a scrape target");
    const res = await request.get(`${API_ADMIN_URL}/metrics`);
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain("# TYPE");
  });

  test("worker admin /livez + /metrics are up @smoke", async ({ request }) => {
    await meta(FEATURE);
    await testCase("NB-504", "a headless worker is as observable as a server");
    expect((await request.get(`${WORKER_ADMIN_URL}/livez`)).status()).toBe(200);
    const metrics = await request.get(`${WORKER_ADMIN_URL}/metrics`);
    expect(metrics.status()).toBe(200);
  });
});
