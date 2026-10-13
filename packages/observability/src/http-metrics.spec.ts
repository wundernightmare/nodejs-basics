import { request as httpRequest } from "node:http";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { captureMetrics, meta, type MetricsCapture, metricValue, testCase } from "@base/testing";

import { methodLabel, registerHttpInstrumentation } from "./http-metrics.js";

const noop = (): void => {};

describe("HTTP server metrics", () => {
  meta({
    epic: "nodejs-basics",
    feature: "observability",
    owner: "@team-platform",
    tags: ["metrics", "unit"],
  });

  let capture: MetricsCapture;
  let app: FastifyInstance;
  let release = noop;
  let handlerEntered: Promise<void>;

  beforeEach(async () => {
    capture = captureMetrics();
    app = Fastify();
    registerHttpInstrumentation(app);
    app.get("/tasks/:id", () => ({ ok: true }));
    let entered = noop;
    handlerEntered = new Promise((resolve) => {
      entered = resolve;
    });
    app.get("/slow", async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ok: true };
    });
    await app.ready();
  });

  afterEach(async () => {
    release();
    await app.close();
    await capture.stop();
  });

  it("counts each request by method, route template and exact status", async () => {
    await testCase("NB-1037", "http_requests_total / _duration_seconds use the template");
    await app.inject({ method: "GET", url: "/tasks/abc" });
    await app.inject({ method: "GET", url: "/tasks/def" });
    await app.inject({ method: "GET", url: "/nope/123" });
    const text = await capture.scrape();
    const ok = { method: "GET", route: "/tasks/:id", status: "200" };
    expect(metricValue(text, "http_requests_total", ok)).toBe(2);
    expect(metricValue(text, "http_requests_total", { route: "unmatched", status: "404" })).toBe(1);
    expect(
      metricValue(text, "http_request_duration_seconds_count", {
        method: "GET",
        route: "/tasks/:id",
      }),
    ).toBe(2);
    expect(metricValue(text, "http_requests_in_flight")).toBe(0);
    expect(text).not.toContain("/tasks/abc");
    expect(text).not.toContain("otel_scope");
  });

  it("bounds the method label: a non-standard method is _OTHER", async () => {
    await testCase("NB-1038", "the method label cannot grow");
    expect(methodLabel("PATCH")).toBe("PATCH");
    expect(methodLabel("PROPFIND")).toBe("_OTHER");
    expect(methodLabel("get")).toBe("_OTHER");
  });

  it("counts a request the client abandoned as 499, once, and releases the in-flight slot", async () => {
    await testCase("NB-1039", "an aborted request does not leak http_requests_in_flight");
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const req = httpRequest(`${address}/slow`);
    req.on("error", () => {});
    req.end();
    await handlerEntered;
    expect(metricValue(await capture.scrape(), "http_requests_in_flight")).toBe(1);

    req.destroy();
    await expect
      .poll(async () =>
        metricValue(await capture.scrape(), "http_requests_total", {
          route: "/slow",
          status: "499",
        }),
      )
      .toBe(1);
    release(); // the handler finishes after the client left: not counted again
    await new Promise((resolve) => setTimeout(resolve, 50));
    const text = await capture.scrape();
    expect(metricValue(text, "http_requests_in_flight")).toBe(0);
    expect(metricValue(text, "http_requests_total", { route: "/slow", status: "200" })).toBe(-1);
    expect(metricValue(text, "http_request_duration_seconds_count", { route: "/slow" })).toBe(1);
  });
});
