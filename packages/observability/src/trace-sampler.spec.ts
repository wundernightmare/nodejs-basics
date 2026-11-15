import { ROOT_CONTEXT, SpanKind, trace, TraceFlags } from "@opentelemetry/api";
import { TraceState } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SamplingDecision,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";

import { forceTrace, isDebugTrace } from "@base/logger";
import { testCase } from "@base/testing";

import { samplerRatio, traceSampler, type TraceSamplerOptions } from "./trace-sampler.js";

function decide(raw: string | undefined, parentSampled?: boolean): SamplingDecision[] {
  const sampler = traceSampler(raw);
  const parent =
    parentSampled === undefined
      ? ROOT_CONTEXT
      : trace.setSpanContext(ROOT_CONTEXT, {
          traceId: "0af7651916cd43dd8448eb211c80319c",
          spanId: "b7ad6b7169203331",
          traceFlags: parentSampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
          isRemote: true,
        });
  return Array.from({ length: 200 }, (_, i) => {
    // Four different words: the ratio sampler XORs them, so a repeated word reads as 0.
    const traceId = [1, 2, 3, 4]
      .map((k) => (Math.imul(i * 4 + k, 2_654_435_761) >>> 0).toString(16).padStart(8, "0"))
      .join("");
    return sampler.shouldSample(parent, traceId, "op", SpanKind.SERVER, {}, []).decision;
  });
}

function sampled(raw: string | undefined): number {
  return decide(raw).filter((d) => d === SamplingDecision.RECORD_AND_SAMPLED).length;
}

describe("traceSampler", () => {
  it("samples the configured share of the traces this service starts", async () => {
    await testCase(
      "NB-1146",
      "OTEL_TRACES_SAMPLER_RATIO: ratio for roots, the parent's decision otherwise",
    );
    expect([sampled(undefined), sampled("1"), sampled("0")]).toEqual([200, 200, 0]);
    expect(sampled("0.5")).toBeGreaterThan(0);
    expect(sampled("0.5")).toBeLessThan(200);
  });

  it("keeps the caller's decision whatever the ratio", async () => {
    await testCase(
      "NB-1146",
      "OTEL_TRACES_SAMPLER_RATIO: ratio for roots, the parent's decision otherwise",
    );
    expect(new Set(decide("0", true))).toEqual(new Set([SamplingDecision.RECORD_AND_SAMPLED]));
    expect(new Set(decide("1", false))).toEqual(new Set([SamplingDecision.NOT_RECORD]));
  });

  it("falls back to everything for a value that is not a ratio", () => {
    expect(["", " ", "half", "-0.1", "1.5", "NaN", "0.25"].map((raw) => samplerRatio(raw))).toEqual(
      [1, 1, 1, 1, 1, 1, 0.25],
    );
  });
});

describe("traceSampler: whom it follows", () => {
  const TRACE = "0af7651916cd43dd8448eb211c80319c";
  const parent = (isSampled: boolean, remote: boolean, state?: string) =>
    trace.setSpanContext(ROOT_CONTEXT, {
      traceId: TRACE,
      spanId: "b7ad6b7169203331",
      traceFlags: isSampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
      ...(remote && { isRemote: true }),
      ...(state !== undefined && { traceState: new TraceState(state) }),
    });
  const sample = (options: TraceSamplerOptions, ctx = ROOT_CONTEXT) => {
    const result = traceSampler(options).shouldSample(ctx, TRACE, "op", SpanKind.SERVER, {}, []);
    return { decision: result.decision, state: result.traceState?.serialize() };
  };
  const { RECORD_AND_SAMPLED: SAMPLED, NOT_RECORD: DROPPED, RECORD: RECORDED } = SamplingDecision;

  it("does not let a caller from outside decide: the ingress draws afresh and drops its tracestate", async () => {
    await testCase(
      "NB-1360",
      "OTEL_TRACES_TRUST_REMOTE_PARENT=false: a remote traceparent does not dictate sampling",
    );
    const ingress = { trustRemoteParent: false };
    // A client-forced `-01` does not get past ratio 0 …
    expect(sample({ ...ingress, ratio: "0" }, parent(true, true, "vendor=x"))).toEqual({
      decision: DROPPED,
      state: "",
    });
    // … and a remote `-00` does not suppress ratio 1.
    expect(sample({ ...ingress, ratio: "1" }, parent(false, true, "vendor=x"))).toEqual({
      decision: SAMPLED,
      state: "",
    });
    // The mark of a debug trace sent by a client is neither followed nor kept.
    expect(sample({ ...ingress, ratio: "0" }, parent(true, true, "dbg=1"))).toEqual({
      decision: DROPPED,
      state: "",
    });
    // A parent inside the process is followed as everywhere.
    expect(sample({ ...ingress, ratio: "0" }, parent(true, false, "vendor=x"))).toEqual({
      decision: SAMPLED,
      state: "vendor=x",
    });
    expect(sample({ ...ingress, ratio: "1" }, parent(false, false)).decision).toBe(DROPPED);
    // By default a remote parent is trusted: a sampled caller keeps its trace whole.
    expect(sample({ ratio: "0" }, parent(true, true, "vendor=x,dbg=1"))).toEqual({
      decision: SAMPLED,
      state: "vendor=x,dbg=1",
    });
  });

  it("draws the redrawn decision from an id of its own, not from the client's", () => {
    // The ratio sampler keeps this id at any ratio above 0: a client that
    // knows it would otherwise be sampled every time.
    const always = "00000000000000000000000000000001";
    const ctx = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: always,
      spanId: "b7ad6b7169203331",
      traceFlags: TraceFlags.NONE,
      isRemote: true,
    });
    const decisions = (trustRemoteParent: boolean) => {
      const sampler = traceSampler({ ratio: "0.5", trustRemoteParent });
      return new Set(
        Array.from(
          { length: 200 },
          () => sampler.shouldSample(ctx, always, "op", SpanKind.SERVER, {}, []).decision,
        ),
      );
    };
    expect(decisions(false)).toEqual(new Set([SAMPLED, DROPPED]));
    expect(decisions(true)).toEqual(new Set([DROPPED]));
  });

  it("samples a forced span whatever the ratio and the parent say, and marks its trace", async () => {
    await testCase("NB-1361", "A debug trace is sampled at any ratio and marked in tracestate");
    for (const trustRemoteParent of [true, false]) {
      expect(sample({ ratio: "0", trustRemoteParent }, forceTrace(ROOT_CONTEXT))).toEqual({
        decision: SAMPLED,
        state: "dbg=1",
      });
    }
    // A trusted parent keeps its own tracestate next to the mark …
    expect(sample({ ratio: "0" }, forceTrace(parent(false, false, "vendor=x")))).toEqual({
      decision: SAMPLED,
      state: "dbg=1,vendor=x",
    });
    expect(sample({ ratio: "0" }, forceTrace(parent(false, true))).state).toBe("dbg=1");
    // … an untrusted one still loses it.
    expect(
      sample({ ratio: "0", trustRemoteParent: false }, forceTrace(parent(false, true, "vendor=x"))),
    ).toEqual({ decision: SAMPLED, state: "dbg=1" });
    // Downstream the mark travels with the sampled flag.
    expect(sample({ ratio: "0" }, parent(true, true, "dbg=1"))).toEqual({
      decision: SAMPLED,
      state: "dbg=1",
    });
  });

  it("records what it does not sample when the retroactive buffer asks, and nothing else changes", async () => {
    await testCase("NB-1362", "The retroactive buffer makes unsampled spans recorded, not sampled");
    const buffered = { recordUnsampled: true };
    expect(sample({ ...buffered, ratio: "0" }).decision).toBe(RECORDED);
    expect(sample({ ...buffered, ratio: "0" }, parent(false, true, "vendor=x"))).toEqual({
      decision: RECORDED,
      state: "vendor=x",
    });
    expect(
      sample({ ...buffered, ratio: "0", trustRemoteParent: false }, parent(true, true, "v=x")),
    ).toEqual({ decision: RECORDED, state: "" });
    expect(sample({ ...buffered, ratio: "0" }, parent(true, true)).decision).toBe(SAMPLED);
    expect(sample({ ...buffered, ratio: "1" }).decision).toBe(SAMPLED);
    expect(sample({ ...buffered, ratio: "0" }, forceTrace(ROOT_CONTEXT)).decision).toBe(SAMPLED);
    expect(sample({ recordUnsampled: false, ratio: "0" }).decision).toBe(DROPPED);
  });

  it("says what it is", () => {
    expect(String(traceSampler("0.25"))).toBe("ParentBased{root:TraceIdRatioBased{0.25}}");
    expect(
      String(traceSampler({ ratio: "1", trustRemoteParent: false, recordUnsampled: true })),
    ).toBe("ParentBased{root:TraceIdRatioBased{1},remote:redrawn,unsampled:recorded}");
  });

  it("a tracer gives the span the tracestate the sampler decided", () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      sampler: traceSampler({ ratio: "0", trustRemoteParent: false, recordUnsampled: true }),
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const tracer = provider.getTracer("t");
    const fromClient = tracer.startSpan("in", {}, parent(true, true, "dbg=1,vendor=x"));
    expect(fromClient.spanContext().traceId).toBe(TRACE);
    expect(fromClient.spanContext().traceFlags).toBe(TraceFlags.NONE);
    expect(fromClient.spanContext().traceState?.serialize()).toBe("");
    expect(isDebugTrace(fromClient.spanContext())).toBe(false);
    const debugged = tracer.startSpan("in", {}, forceTrace(parent(false, true, "vendor=x")));
    expect(isDebugTrace(debugged.spanContext())).toBe(true);
    expect(debugged.spanContext().traceState?.serialize()).toBe("dbg=1");
  });
});
