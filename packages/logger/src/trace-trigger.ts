/**
 * The trigger side of retroactive sampling (@base/observability, retro/):
 * what the logger tells about an unsampled trace, and asks of it.
 *
 * The buffer lives in @base/observability, which depends on this package, so
 * the logger knows it only as this interface. setupTelemetry() binds the
 * buffer; without one nothing is bound and an unsampled trace is never
 * exported.
 *
 * The counterpart of TraceTrigger / BindTraceTrigger in golang-basics'
 * libs/httpx.
 */
import { isSpanContextValid, trace, TraceFlags } from "@opentelemetry/api";

export interface TraceTrigger {
  /**
   * Called when a warn or error line of an unsampled trace is written;
   * whether the trace is exported, now or before.
   */
  triggerByLog(traceId: string): boolean;
  /** Whether the unsampled trace was triggered. */
  isTriggered(traceId: string): boolean;
}

let bound: TraceTrigger | undefined;

/**
 * Makes the warn and error lines of every logger of this package trigger the
 * export of their unsampled trace through `trigger` (undefined unbinds). One
 * per process: the last one bound.
 */
export function bindTraceTrigger(trigger: TraceTrigger | undefined): void {
  bound = trigger;
}

/**
 * Whether the unsampled trace of a line has a trace to link to — and makes it
 * have one when the line is a warn or an error.
 */
export function unsampledTraceExported(traceId: string, triggers: boolean): boolean {
  if (bound === undefined) return false;
  return triggers ? bound.triggerByLog(traceId) : bound.isTriggered(traceId);
}

/**
 * Asks the bound trigger to export the trace of the active span when it is
 * unsampled: for a caller that knows the trace matters without having a warn
 * line to say so (a debug subject).
 */
export function triggerActiveTrace(): void {
  const ctx = trace.getActiveSpan()?.spanContext();
  if (ctx === undefined || !isSpanContextValid(ctx)) return;
  if ((ctx.traceFlags & TraceFlags.SAMPLED) === 0) bound?.triggerByLog(ctx.traceId);
}
