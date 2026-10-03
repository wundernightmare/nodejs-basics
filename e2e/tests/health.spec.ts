import { expect, test } from "@playwright/test";

import { METRIC_REGISTRY } from "@base/observability/metrics-registry";

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

  test("every exported metric is in the metrics registry", async ({ request }) => {
    await meta(FEATURE);
    await testCase("NB-994", "/metrics never shows a metric --metrics-reference does not explain");
    // The exporter renames (dots → _, unit and _total suffixes); HELP keeps the description.
    const documented = new Set(METRIC_REGISTRY.map((m) => m.description));
    await request.get("/health"); // some HTTP traffic first
    const undocumented: string[] = [];
    let families = 0;
    const scrapes = await Promise.all(
      [`${API_ADMIN_URL}/metrics`, `${WORKER_ADMIN_URL}/metrics`].map(async (url) =>
        (await request.get(url)).text(),
      ),
    );
    for (const text of scrapes) {
      for (const m of text.matchAll(/^# HELP (\S+) (.*)$/gmu)) {
        const [, family = "", help = ""] = m;
        families++;
        if (family !== "target_info" && !documented.has(help))
          undocumented.push(`${family}: ${help}`);
      }
    }
    expect(families).toBeGreaterThan(20); // the scrape itself still works
    expect(undocumented).toEqual([]);
  });
});
