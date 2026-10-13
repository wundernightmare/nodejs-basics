import { UnrecoverableError } from "bullmq";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { captureMetrics, meta, type MetricsCapture, metricValue, testCase } from "@base/testing";

import { isFinalAttempt } from "./bullmq-job-queue.js";
import { JobMetrics } from "./job-metrics.js";

const boom = (): Promise<void> => Promise.reject(new Error("boom"));
const job = (attemptsMade: number) => ({ attemptsMade, opts: { attempts: 3 } });

describe("JobMetrics", () => {
  meta({ epic: "nodejs-basics", feature: "jobs", owner: "@team-platform", tags: ["metrics"] });
  let capture: MetricsCapture;
  beforeEach(() => {
    capture = captureMetrics();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it("counts every attempt: completed, retried while attempts are left, failed on the last", async () => {
    await testCase("NB-1043", "job_runs_total sees each attempt, whatever the backend");
    const m = new JobMetrics("q");
    let last = false;
    await m.run(
      () => Promise.resolve(),
      () => last,
    );
    await expect(m.run(boom, () => last)).rejects.toThrow("boom");
    last = true;
    await expect(m.run(boom, () => last)).rejects.toThrow("boom");
    const text = await capture.scrape();
    const runs = (result: string): number =>
      metricValue(text, "job_runs_total", { queue: "q", result });
    expect([runs("completed"), runs("retried"), runs("failed")]).toEqual([1, 1, 1]);
    expect(metricValue(text, "job_duration_seconds_count", { queue: "q" })).toBe(3);
  });

  it("BullMQ: the last attempt, or an UnrecoverableError on any attempt, is final", async () => {
    await testCase("NB-1044", "an unrecoverable job counts as failed at once");
    expect(isFinalAttempt(job(0), new Error("x"))).toBe(false);
    expect(isFinalAttempt(job(2), new Error("x"))).toBe(true);
    expect(isFinalAttempt(job(0), new UnrecoverableError("never"))).toBe(true);
  });
});
