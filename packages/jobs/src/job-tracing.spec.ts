import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { Job, JobsOptions, Queue } from "bullmq";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { captureSpans, meta, testCase } from "@base/testing";

import { addTraced, traceJob, traceSend } from "./job-tracing.js";

const spans = captureSpans();

/** A queue whose add() returns the job BullMQ would store. */
function fakeQueue(): Queue {
  return {
    name: "task-events",
    add: (name: string, data: unknown, opts: JobsOptions) =>
      Promise.resolve({
        id: opts.jobId,
        name,
        data,
        opts,
        queueName: "task-events",
        attemptsMade: 0,
      }),
  } as unknown as Queue;
}

describe("job tracing", () => {
  meta({
    epic: "nodejs-basics",
    feature: "tracing",
    owner: "@team-platform",
    tags: ["jobs", "tracing", "unit"],
  });

  beforeEach(() => {
    spans.reset();
  });
  afterAll(() => {
    spans.stop();
  });

  it("stores the enqueuing span's context with the job and continues it in the processor", async () => {
    await testCase("NB-411", "process span is a child of the send span across the queue");
    const job = await addTraced(fakeQueue(), "process-task", { id: "t1" }, { jobId: "t1" });
    expect(job.opts.telemetry?.metadata).toContain("traceparent");

    await traceJob(job, () => Promise.resolve());

    const send = spans.span("send task-events");
    const process = spans.span("process task-events");
    expect(send.kind).toBe(SpanKind.PRODUCER);
    expect(send.attributes["messaging.message.id"]).toBe("t1");
    expect(process.kind).toBe(SpanKind.CONSUMER);
    expect(process.parentSpanContext?.spanId).toBe(send.spanContext().spanId);
    expect(process.attributes).toMatchObject({
      "messaging.system": "bullmq",
      "messaging.destination.name": "task-events",
      "bullmq.job.name": "process-task",
    });
  });

  it("starts a new trace for a job without usable metadata and records a failure", async () => {
    await testCase("NB-412", "garbage metadata → root span; a throw fails it");
    const job = {
      id: "t2",
      name: "process-task",
      queueName: "task-events",
      attemptsMade: 1,
      opts: { telemetry: { metadata: "not json" } },
    } as unknown as Job;

    await expect(traceJob(job, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");

    const process = spans.span("process task-events");
    expect(process.parentSpanContext).toBeUndefined();
    expect(process.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("a failed send ends its span with the error and rethrows", async () => {
    await testCase("NB-1014", "an enqueue that fails is an error span, not a silent one");
    await expect(
      traceSend("pg-boss", "q", "id-1", () => Promise.reject(new Error("db down"))),
    ).rejects.toThrow("db down");
    const send = spans.span("send q");
    expect(send.status).toMatchObject({ code: SpanStatusCode.ERROR, message: "db down" });
    expect(send.attributes["messaging.system"]).toBe("pg-boss");
  });
});
