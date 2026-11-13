import { ROOT_CONTEXT, SpanKind, trace, TraceFlags } from "@opentelemetry/api";
import { SamplingDecision } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";

import { testCase } from "@base/testing";

import { samplerRatio, traceSampler } from "./trace-sampler.js";

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
