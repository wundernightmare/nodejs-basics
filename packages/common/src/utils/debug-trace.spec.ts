import { context, ROOT_CONTEXT, trace, TraceFlags, type TraceState } from "@opentelemetry/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { captureSpans, type SpanCapture } from "@base/testing";

import { followDebugTrace, forceTrace, isDebugTrace, isTraceForced } from "./debug-trace.js";
import { isDebugLogging, withDebugLogging } from "./request-context.js";

/** The one key a test needs of a tracestate. */
function state(entries: Record<string, string>): TraceState {
  const self: TraceState = {
    get: (key) => entries[key],
    set: () => self,
    unset: () => self,
    serialize: () =>
      Object.entries(entries)
        .map(([k, v]) => `${k}=${v}`)
        .join(","),
  };
  return self;
}

const spanContext = (sampled: boolean, entries?: Record<string, string>) => ({
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  traceFlags: sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
  ...(entries !== undefined && { traceState: state(entries) }),
});

describe("debug trace", () => {
  // For its context manager: the active span has to survive a callback.
  let capture: SpanCapture;
  beforeAll(() => {
    capture = captureSpans();
  });
  afterAll(() => {
    capture.stop();
  });

  it("is a trace that is both sampled and marked", () => {
    expect(isDebugTrace(spanContext(true, { dbg: "1" }))).toBe(true);
    expect(isDebugTrace(spanContext(true, { vendor: "x", dbg: "1" }))).toBe(true);
    // The mark without the flag is a trace nobody stores.
    expect(isDebugTrace(spanContext(false, { dbg: "1" }))).toBe(false);
    expect(isDebugTrace(spanContext(true, { dbg: "0" }))).toBe(false);
    expect(isDebugTrace(spanContext(true, { debug: "1" }))).toBe(false);
    expect(isDebugTrace(spanContext(true))).toBe(false);
    expect(isDebugTrace(undefined)).toBe(false);
  });

  it("asks the sampler through the context, and only through the one it marked", () => {
    expect(isTraceForced(ROOT_CONTEXT)).toBe(false);
    const forced = forceTrace(ROOT_CONTEXT);
    expect(isTraceForced(forced)).toBe(true);
    expect(isTraceForced(ROOT_CONTEXT)).toBe(false);
    expect(isTraceForced(forced.setValue(Symbol("other"), true))).toBe(true);
  });

  it("turns debug logging on for the work of a marked trace, and for no other", () => {
    const under = (sc: ReturnType<typeof spanContext> | undefined): boolean =>
      context.with(sc === undefined ? ROOT_CONTEXT : trace.setSpanContext(ROOT_CONTEXT, sc), () =>
        followDebugTrace(() => isDebugLogging()),
      );
    expect(under(spanContext(true, { dbg: "1" }))).toBe(true);
    expect(under(spanContext(false, { dbg: "1" }))).toBe(false);
    expect(under(spanContext(true))).toBe(false);
    expect(under(undefined)).toBe(false);
    // Already on: stays on, whatever the trace is.
    expect(withDebugLogging(() => under(spanContext(true)))).toBe(true);
    // Not left on behind it.
    expect(isDebugLogging()).toBe(false);
    // The result and a throw pass through.
    expect(followDebugTrace(() => 42)).toBe(42);
    expect(() =>
      followDebugTrace(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
  });
});
