import {
  type Attributes,
  type Context,
  isSpanContextValid,
  type Link,
  type SpanKind,
  trace,
  TraceFlags,
} from "@opentelemetry/api";
import { TraceState } from "@opentelemetry/core";
import {
  RandomIdGenerator,
  type Sampler,
  SamplingDecision,
  type SamplingResult,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";

import { DEBUG_TRACESTATE_KEY, DEBUG_TRACESTATE_VALUE, isTraceForced } from "@base/logger";

export interface TraceSamplerOptions {
  /** OTEL_TRACES_SAMPLER_RATIO as it is in the environment. */
  ratio?: string | undefined;
  /**
   * Follow the sampled flag of a remote parent (OTEL_TRACES_TRUST_REMOTE_PARENT).
   * Default: true.
   */
  trustRemoteParent?: boolean;
  /** Record the spans that are not sampled: the retroactive buffer keeps them. */
  recordUnsampled?: boolean;
}

/**
 * The head-sampling policy of every service.
 *
 * One rule for a pipeline: the decision is made once, at the root of the
 * trace, and everyone downstream follows it. A span with a parent takes the
 * parent's sampled flag; only a root is drawn at the ratio
 * (OTEL_TRACES_SAMPLER_RATIO; unset or not a number in 0..1 is 1 — the config
 * check reports the bad value at boot). A request sampled at the edge stays
 * sampled through every service behind it, and an unsampled one is never
 * sampled again at some other service's ratio.
 *
 * The exception is the public ingress (trustRemoteParent off): a traceparent
 * on a request from the internet is the client's — its sampled flag, and its
 * trace id, whose low bits the ratio sampler keys on. Following either would
 * let any client have 100% of its requests traced through the whole
 * pipeline. For a remote parent the decision is therefore drawn afresh at the
 * ratio from a random id, and the client's tracestate is dropped. The trace
 * id itself is kept — a caller that sends traceparent can still find its
 * trace — and local parents are followed as everywhere.
 *
 * A span started under forceTrace() (a request with the debug token) is
 * sampled whatever the ratio and the parent say, and its tracestate gets the
 * debug mark: every service downstream follows the sampled flag as usual.
 *
 * With recordUnsampled (the retroactive buffer is on) a span that is not
 * sampled is recorded all the same, so that the buffer can export it later;
 * its sampled flag, and so the decision downstream, is unchanged.
 *
 * This is head sampling. When the collector does tail sampling
 * (docker/otel-collector/config.yaml) the ratio stays 1: the collector can
 * only keep an error or a slow trace that was sent to it.
 *
 * The same rules as golang-basics' otelx and tracehub's telemetry crate.
 */
export function traceSampler(options: TraceSamplerOptions | string | undefined = {}): Sampler {
  return new TraceSampler(typeof options === "object" ? options : { ratio: options });
}

/** A tracestate with nothing in it: what overrides the one of a parent. */
const NO_STATE = new TraceState();

class TraceSampler implements Sampler {
  readonly #root: Sampler;
  readonly #trustRemote: boolean;
  readonly #recordUnsampled: boolean;
  readonly #draw = new RandomIdGenerator();

  constructor(options: TraceSamplerOptions) {
    this.#root = new TraceIdRatioBasedSampler(samplerRatio(options.ratio));
    this.#trustRemote = options.trustRemoteParent ?? true;
    this.#recordUnsampled = options.recordUnsampled ?? false;
  }

  shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[],
  ): SamplingResult {
    const result = this.#decide(context, traceId, spanName, spanKind, attributes, links);
    if (this.#recordUnsampled && result.decision === SamplingDecision.NOT_RECORD) {
      return { ...result, decision: SamplingDecision.RECORD };
    }
    return result;
  }

  #decide(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[],
  ): SamplingResult {
    const parent = trace.getSpanContext(context);
    const valid = parent !== undefined && isSpanContextValid(parent);
    const untrusted = valid && !this.#trustRemote && parent.isRemote === true;
    // What the new span inherits: nothing from a parent that is not there or
    // not trusted. (The tracer keeps the parent's tracestate unless it is
    // given another, so "nothing" has to be said with an empty one.)
    const state = valid && !untrusted ? parent.traceState : NO_STATE;

    if (isTraceForced(context)) {
      return {
        decision: SamplingDecision.RECORD_AND_SAMPLED,
        traceState: (state ?? NO_STATE).set(DEBUG_TRACESTATE_KEY, DEBUG_TRACESTATE_VALUE),
      };
    }
    if (!valid) {
      const drawn = this.#root.shouldSample(
        context,
        traceId,
        spanName,
        spanKind,
        attributes,
        links,
      );
      return { decision: drawn.decision };
    }
    if (untrusted) {
      const drawn = this.#root.shouldSample(
        context,
        this.#draw.generateTraceId(),
        spanName,
        spanKind,
        attributes,
        links,
      );
      return { decision: drawn.decision, traceState: NO_STATE };
    }
    const sampled = (parent.traceFlags & TraceFlags.SAMPLED) !== 0;
    return {
      decision: sampled ? SamplingDecision.RECORD_AND_SAMPLED : SamplingDecision.NOT_RECORD,
      // Stryker disable next-line ConditionalExpression: an absent tracestate and `undefined` are the same to the tracer
      ...(state !== undefined && { traceState: state }),
    };
  }

  toString(): string {
    const parts = [`root:${this.#root.toString()}`];
    if (!this.#trustRemote) parts.push("remote:redrawn");
    if (this.#recordUnsampled) parts.push("unsampled:recorded");
    return `ParentBased{${parts.join(",")}}`;
  }
}

export function samplerRatio(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 1;
  const ratio = Number(raw);
  // Stryker disable next-line EqualityOperator: 1 is the fallback as well
  return Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 ? ratio : 1;
}
