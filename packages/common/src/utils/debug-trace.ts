/**
 * A debug trace is a request traced and logged in every service it passes
 * through, whatever the sampling ratio:
 *
 *  1. Ingress. A request with a valid X-Debug-Token is marked by forceTrace()
 *     before its server span starts (the propagator of @base/observability
 *     does it). The sampler samples a span started under such a context and
 *     puts the mark `dbg=1` into its tracestate.
 *  2. Propagation. The mark travels with traceparent / tracestate — HTTP
 *     headers, Kafka headers, the carrier of a job; the sampled flag makes
 *     every service downstream export its spans (they follow the parent).
 *  3. Downstream. A unit of work whose span carries the mark runs under
 *     followDebugTrace(): its log lines pass whatever the level and the log
 *     sampler say.
 *
 * The mark cannot come from the internet when the service does not trust
 * remote parents (OTEL_TRACES_TRUST_REMOTE_PARENT=false, the public edge):
 * the tracestate of a remote parent is dropped there, so only the service's
 * own debug token sets it.
 *
 * The same contract as golang-basics' libs/httpx (ForceTrace, IsDebugTrace,
 * FollowDebugTrace): a debug trace crosses services of both stacks.
 */
import {
  type Context,
  createContextKey,
  type SpanContext,
  trace,
  TraceFlags,
} from "@opentelemetry/api";

import { debugLoggingStorage, isDebugLogging } from "./request-context.js";

/** The tracestate key of the mark (a W3C simple key). */
export const DEBUG_TRACESTATE_KEY = "dbg";
/** The value of the mark. */
export const DEBUG_TRACESTATE_VALUE = "1";

const FORCE_TRACE = createContextKey("@base/common force-trace");

/**
 * `ctx` asking the sampler to sample the spans started under it and to mark
 * their trace as a debug trace. Use it before the span is started: the
 * decision of a span is taken once.
 */
export function forceTrace(ctx: Context): Context {
  return ctx.setValue(FORCE_TRACE, true);
}

/** Whether `ctx` was marked by forceTrace(). It is what a sampler asks. */
export function isTraceForced(ctx: Context): boolean {
  return ctx.getValue(FORCE_TRACE) === true;
}

/** Whether the span context belongs to a debug trace: sampled and marked. */
export function isDebugTrace(spanContext: SpanContext | undefined): boolean {
  return (
    spanContext !== undefined &&
    (spanContext.traceFlags & TraceFlags.SAMPLED) !== 0 &&
    spanContext.traceState?.get(DEBUG_TRACESTATE_KEY) === DEBUG_TRACESTATE_VALUE
  );
}

/**
 * Runs fn with debug logging on when the active span belongs to a debug
 * trace, and just runs it otherwise. Whatever starts the span of a unit of
 * work (a server, a consumer) calls it right after.
 */
export function followDebugTrace<T>(fn: () => T): T {
  if (isDebugLogging() || !isDebugTrace(trace.getActiveSpan()?.spanContext())) return fn();
  return debugLoggingStorage.run(true, fn);
}
