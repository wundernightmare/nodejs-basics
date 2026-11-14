import { Writable } from "node:stream";

import { trace } from "@opentelemetry/api";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { captureSpans, type SpanCapture, testCase } from "@base/testing";

import {
  DEBUG_SUBJECT_ATTRIBUTE,
  DebugSubjects,
  MAX_DEBUG_SUBJECTS,
  runAsDebugSubject,
} from "./debug-subjects.js";
import { LogLevel } from "./log-level.js";
import { buildPinoOptions } from "./pino.config.js";

const HOUR = 3_600_000;

function clocked(maxTtlMs = 24 * HOUR, max = MAX_DEBUG_SUBJECTS) {
  const clock = { now: Date.parse("2026-01-01T00:00:00Z") };
  return {
    clock,
    subjects: new DebugSubjects(
      () => maxTtlMs,
      () => clock.now,
      max,
    ),
  };
}

describe("debug subjects", () => {
  let spans: SpanCapture;
  beforeAll(() => {
    spans = captureSpans();
  });
  afterAll(() => {
    spans.stop();
  });

  it("one tenant gets debug logs and a marked trace; the others and the tenant after its TTL do not", async () => {
    await testCase("NB-1253", "Debug subjects: debug logs and a marked span for one subject");
    const { clock, subjects } = clocked();
    const lines: Array<{ message: string }> = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(JSON.parse(chunk.toString()) as { message: string });
        cb();
      },
    });
    const logger = pino(buildPinoOptions(new LogLevel("warn")), sink);
    const handle = (tenant: string): void => {
      trace.getTracer("test").startActiveSpan(`request ${tenant}`, (span) => {
        runAsDebugSubject(subjects, tenant, () => {
          logger.debug(`working for ${tenant}`);
        });
        span.end();
      });
    };

    expect(subjects.put("tenant-42", 15 * 60_000)).toBe(true);
    handle("tenant-42");
    handle("tenant-7");
    expect(lines.map((line) => line.message)).toEqual(["working for tenant-42"]);
    expect(spans.span("request tenant-42").attributes[DEBUG_SUBJECT_ATTRIBUTE]).toBe("tenant-42");
    expect(spans.span("request tenant-7").attributes[DEBUG_SUBJECT_ATTRIBUTE]).toBeUndefined();

    clock.now += 15 * 60_000; // the TTL ran out: no timer, checked at use
    spans.reset();
    handle("tenant-42");
    expect(lines).toHaveLength(1);
    expect(spans.span("request tenant-42").attributes[DEBUG_SUBJECT_ATTRIBUTE]).toBeUndefined();
    expect(subjects.snapshot().subjects).toEqual([]);
  });

  it("is bounded: a full list refuses a new subject, extends a known one, and makes room once entries expire", async () => {
    await testCase("NB-1254", "Debug subjects: bounded list, TTL capped");
    const { clock, subjects } = clocked(HOUR, 3);
    expect(subjects.put("a", 60_000)).toBe(true);
    expect(subjects.put("b", 10 * HOUR)).toBe(true); // capped at the hour
    expect(subjects.put("c", 30 * 60_000)).toBe(true);
    expect(subjects.put("d", 60_000)).toBe(false);
    expect(subjects.put("a", 2 * 60_000)).toBe(true); // extending is not adding

    const start = clock.now;
    expect(subjects.snapshot()).toEqual({
      subjects: [
        { subject: "a", expires_at: new Date(start + 2 * 60_000).toISOString() },
        { subject: "b", expires_at: new Date(start + HOUR).toISOString() },
        { subject: "c", expires_at: new Date(start + 30 * 60_000).toISOString() },
      ],
      max_ttl: "1h",
    });

    clock.now += 2 * 60_000; // "a" expired
    expect(subjects.put("d", 60_000)).toBe(true);
    expect(subjects.snapshot().subjects.map((entry) => entry.subject)).toEqual(["b", "c", "d"]);

    subjects.remove("b");
    subjects.remove("b"); // idempotent
    expect(subjects.active("b")).toBe(false);
    expect(subjects.active("c")).toBe(true);
  });

  it("an empty or unlisted subject just runs the work", async () => {
    await testCase("NB-1255", "Debug subjects: nothing listed costs nothing");
    const { subjects } = clocked();
    expect(runAsDebugSubject(subjects, undefined, () => 1)).toBe(1);
    expect(runAsDebugSubject(subjects, "", () => 2)).toBe(2);
    expect(runAsDebugSubject(subjects, "nobody", () => 3)).toBe(3);
  });
});
