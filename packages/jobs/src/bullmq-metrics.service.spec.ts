import { EventEmitter } from "node:events";

import { metrics, type Meter } from "@opentelemetry/api";
import type { Job, Worker } from "bullmq";
import { afterEach, describe, expect, it, vi } from "vitest";

import { meta, testCase } from "@base/testing";

import { BullMQMetricsService } from "./bullmq-metrics.service.js";

/** A meter whose instruments log every add/record as `name value attrs`. */
function recordingMeter(): string[] {
  const calls: string[] = [];
  const instrument = (name: string) => ({
    add: (v: number, a: object) => calls.push(`${name} ${v} ${JSON.stringify(a)}`),
    record: (v: number, a: object) => calls.push(`${name} ${v} ${JSON.stringify(a)}`),
  });
  vi.spyOn(metrics, "getMeter").mockReturnValue({
    createCounter: instrument,
    createHistogram: instrument,
  } as unknown as Meter);
  return calls;
}

const job = (attemptsMade: number, attempts?: number): Job =>
  ({ attemptsMade, opts: { attempts }, processedOn: 1_000, finishedOn: 1_250 }) as unknown as Job;

describe("BullMQMetricsService.observe", () => {
  meta({ epic: "nodejs-basics", feature: "jobs", owner: "@team-platform", tags: ["jobs"] });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("counts completed, final failures and stalls; times every attempt", async () => {
    await testCase("NB-910", "job metrics are recorded from worker events");
    const calls = recordingMeter();
    const events = Object.assign(new EventEmitter(), { name: "q" });
    new BullMQMetricsService().observe(events as unknown as Worker);

    events.emit("completed", job(1));
    events.emit("failed", job(1, 3), new Error("retry")); // will be retried
    events.emit("failed", job(3, 3), new Error("final"));
    events.emit("stalled", "id");

    expect(calls).toEqual([
      'bullmq.job.completed.total 1 {"queue":"q"}',
      'bullmq.job.duration.ms 250 {"queue":"q","outcome":"completed"}',
      'bullmq.job.duration.ms 250 {"queue":"q","outcome":"failed"}',
      'bullmq.job.duration.ms 250 {"queue":"q","outcome":"failed"}',
      'bullmq.job.failed.total 1 {"queue":"q"}',
      'bullmq.job.stalled.total 1 {"queue":"q"}',
    ]);
  });
});
