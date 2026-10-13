import { metrics } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captureMetrics, meta, type MetricsCapture, metricValue, testCase } from "@base/testing";

import { EVENT_LOOP_WINDOW_MS, registerNodeMetrics } from "./node-metrics.js";

const noop = (): void => {};

async function cpuSeconds(capture: MetricsCapture): Promise<number> {
  return metricValue(await capture.scrape(), "process_cpu_user_seconds_total");
}

function p99(text: string): number {
  return metricValue(text, "nodejs_eventloop_delay_seconds", { quantile: "0.99" });
}

describe("process and runtime metrics", () => {
  meta({
    epic: "nodejs-basics",
    feature: "observability",
    owner: "@team-platform",
    tags: ["metrics", "unit"],
  });

  let capture: MetricsCapture;
  let stop = noop;
  beforeEach(() => {
    capture = captureMetrics();
  });
  afterEach(async () => {
    stop();
    vi.useRealTimers();
    await capture.stop();
  });

  it("CPU is cumulative seconds since start: it never goes down between scrapes", async () => {
    await testCase("NB-1047", "process_cpu_*_seconds_total is a counter, not a per-scrape delta");
    stop = registerNodeMetrics(metrics.getMeter("nodejs"), { version: "1.2.3", revision: "abc" });
    const first = await cpuSeconds(capture);
    const until = Date.now() + 30;
    while (Date.now() < until) {
      // burn a little CPU
    }
    const second = await cpuSeconds(capture);
    const third = await cpuSeconds(capture);
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThanOrEqual(second);
    expect(third).toBeCloseTo(process.cpuUsage().user / 1e6, 0);
  });

  it("names, units in the name, build identity", async () => {
    await testCase("NB-1048", "the runtime metrics golang-basics also exports");
    stop = registerNodeMetrics(metrics.getMeter("nodejs"), { version: "1.2.3", revision: "abc" });
    const text = await capture.scrape();
    expect(metricValue(text, "build_info", { version: "1.2.3", revision: "abc" })).toBe(1);
    expect(metricValue(text, "nodejs_version_info", { version: process.version })).toBe(1);
    expect(metricValue(text, "process_resident_memory_bytes")).toBeGreaterThan(0);
    expect(metricValue(text, "nodejs_heap_limit_bytes")).toBeGreaterThan(
      metricValue(text, "nodejs_heap_used_bytes"),
    );
    const start = metricValue(text, "process_start_time_seconds");
    expect(Math.abs(start - (Date.now() / 1000 - process.uptime()))).toBeLessThan(2);
  });

  it("event loop delay is a fixed window: scraping does not reset it", async () => {
    await testCase("NB-1049", "two scrapers see the same event-loop numbers");
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    stop = registerNodeMetrics(metrics.getMeter("nodejs"), { version: "v", revision: "r" });
    await new Promise((resolve) => setTimeout(resolve, 60)); // let the monitor sample
    vi.advanceTimersByTime(EVENT_LOOP_WINDOW_MS);
    const a = await capture.scrape();
    const b = await capture.scrape();
    expect(p99(a)).toBeGreaterThan(0);
    expect(p99(b)).toBe(p99(a));
  });
});
