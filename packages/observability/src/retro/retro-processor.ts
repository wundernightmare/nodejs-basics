/**
 * Retroactive sampling inside one process: the spans of an unsampled trace
 * are kept for a while, and a warn / error log line of that trace sends them
 * to the trace store after all.
 *
 * Head sampling decides before the request is processed, so the trace of a
 * failure is kept only by luck (the ratio). With the buffer on:
 *
 *  1. the sampler records an unsampled span instead of dropping it
 *     (trace-sampler.ts, recordUnsampled);
 *  2. RetroProcessor passes sampled spans on to the exporting processor; an
 *     unsampled one is encoded into an arena of byte rings (arena.ts) and let
 *     go — the oldest spans leave the arena when it is full;
 *  3. a log line of level warn or above written inside an unsampled span
 *     triggers its trace (@base/logger asks the trigger bound to it): the
 *     spans of the trace are decoded and exported, and so is every span of it
 *     that ends later. The line carries trace.id, as the lines of a sampled
 *     trace do; the other lines of an unsampled trace carry the id as
 *     trace.unsampled_id — found together, never a dead link.
 *
 * The budget: the memory of the arena (OTEL_RETRO_BUFFER_MIB), allocated once
 * and never exceeded, and the traces triggered a second at most
 * (OTEL_RETRO_TRIGGERS_PER_SECOND) — a storm of errors does not become a
 * storm of exports.
 *
 * Limits. What is not guaranteed is the past: a span that left the arena
 * before the trigger is gone, and trace_retro_buffer_horizon_seconds shows
 * how far back it reaches. A restart loses the arena.
 *
 * Across services. The trigger is local: the decision sent downstream stays
 * "not sampled", so the trace holds the spans of this process (the lines of
 * the other services carry the same id as trace.unsampled_id). trigger() is
 * where a bus between the services plugs in — it exports a trace another
 * service asked for, on a rate of its own — and onLocalTrigger() tells the
 * bus what this one triggered.
 *
 * At sample ratio 1 with trusted parents nothing is unsampled and the arena
 * stays empty.
 *
 * The design of golang-basics' libs/otelx/retro and of wundernightmare's telemetry
 * crate (the rate apart for triggers from outside is the crate's).
 */
import { type Context, type Meter, TraceFlags } from "@opentelemetry/api";
import type { Resource } from "@opentelemetry/resources";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";

import {
  Arena,
  type ArenaUsage,
  HEADER_BYTES,
  type TriggerOutcome,
  type TriggerSource,
} from "./arena.js";
import { asSampled, SpanCodec } from "./codec.js";

export interface RetroOptions {
  /** Memory of the arena in bytes, allocated at start. */
  capacityBytes: number;
  /** Traces a warn / error line of this process may trigger a second. */
  triggersPerSecond: number;
  /** Traces trigger() may export a second; the same rate as the local ones when not given. */
  remoteTriggersPerSecond?: number;
  /** Shards of the arena (tests). */
  shards?: number;
  /** The clock of the rate limit, in ms. */
  now?: () => number;
}

export interface RetroUsage extends ArenaUsage {
  capacityBytes: number;
  exported: number;
  unencodable: number;
  undecodable: number;
}

/**
 * A trace id as every span context of this process has it — lowercase, not
 * all zeros. The ids are compared as text, so another spelling of the same
 * id would be another trace.
 */
const TRACE_ID = /^(?!0{32})[0-9a-f]{32}$/u;

/**
 * A span processor in front of the exporting one: sampled spans pass through,
 * unsampled ones wait in the arena for a trigger.
 */
export class RetroProcessor implements SpanProcessor {
  readonly #inner: SpanProcessor;
  readonly #arena: Arena;
  readonly #codec = new SpanCodec();
  readonly #now: () => number;
  /** A record being put together: the header's room, then the encoded span. */
  readonly #scratch: Buffer;
  /** The resource of the provider, taken from the first span seen: the bytes do not repeat it. */
  #resource: Resource | undefined;
  #observer: ((traceId: string) => void) | undefined;
  #exported = 0;
  #unencodable = 0;
  #undecodable = 0;

  /** `inner` is the batch processor in front of the exporter. */
  constructor(inner: SpanProcessor, options: RetroOptions) {
    this.#inner = inner;
    this.#arena = new Arena(options);
    this.#now = options.now ?? Date.now;
    this.#scratch = Buffer.allocUnsafeSlow(Math.max(this.#arena.recordMaxBytes, HEADER_BYTES));
  }

  onStart(span: Span, parentContext: Context): void {
    this.#inner.onStart(span, parentContext);
  }

  onEnding(span: Span): void {
    this.#inner.onEnding?.(span);
  }

  /** A sampled span passes; an unsampled one is kept, or exported when its trace is triggered. */
  onEnd(span: ReadableSpan): void {
    const context = span.spanContext();
    if ((context.traceFlags & TraceFlags.SAMPLED) !== 0) {
      this.#inner.onEnd(span);
      return;
    }
    const traceId = context.traceId;
    // A trace that is triggered already: no need to encode the span.
    if (this.#arena.isTriggered(traceId)) {
      this.#export(asSampled(span));
      return;
    }
    this.#resource ??= span.resource;

    let text: string;
    try {
      text = this.#codec.encode(span);
    } catch {
      this.#unencodable += 1;
      return;
    }
    if (Buffer.byteLength(text) > this.#scratch.length - HEADER_BYTES) {
      this.#arena.refuse(traceId);
      return;
    }
    const written = this.#scratch.write(text, HEADER_BYTES);
    const [seconds, nanos] = span.endTime;
    this.#arena.offer(
      traceId,
      seconds * 1_000 + nanos / 1e6,
      this.#scratch.subarray(0, HEADER_BYTES + written),
    );
  }

  #export(span: ReadableSpan): void {
    this.#exported += 1;
    this.#inner.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.#inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.#inner.shutdown();
  }

  /**
   * Exports the unsampled trace: the spans of it the arena kept, and every
   * span of it that ends later. This is the entry for a trigger that comes
   * from outside the process — it is not reported to onLocalTrigger() and
   * has a rate of its own. "invalid" for what is not a trace id.
   */
  trigger(traceId: string): TriggerOutcome | "invalid" {
    return TRACE_ID.test(traceId) ? this.#trigger(traceId, "remote") : "invalid";
  }

  /**
   * The local trigger: a warn / error line of an unsampled trace was
   * written. Whether the trace is exported, now or before — whether the line
   * may carry trace.id.
   */
  triggerByLog(traceId: string): boolean {
    return TRACE_ID.test(traceId) && this.#trigger(traceId, "local") !== "rate_limited";
  }

  /** Whether the unsampled trace was triggered: its lines link to a trace. */
  isTriggered(traceId: string): boolean {
    return this.#arena.isTriggered(traceId);
  }

  /**
   * Calls `observer` with the id of every trace this process triggers by
   * itself (a warn / error line) and that the rate limit accepted — what a
   * bus would tell the other services. One observer per process: false when
   * there is one already. It runs inside the log call and must not throw.
   */
  onLocalTrigger(observer: (traceId: string) => void): boolean {
    if (this.#observer !== undefined) return false;
    this.#observer = observer;
    return true;
  }

  #trigger(traceId: string, source: TriggerSource): TriggerOutcome {
    const { outcome, payloads } = this.#arena.trigger(traceId, source, this.#now());
    for (const payload of payloads) {
      // A payload is a span that was kept, and keeping the first one set the resource.
      const span = this.#codec.decode(payload, traceId, this.#resource as Resource);
      // Stryker disable next-line all: only bytes this codec did not write get here
      if (span === undefined) this.#undecodable += 1;
      else this.#export(span);
    }
    if (source === "local" && outcome === "accepted") this.#observer?.(traceId);
    return outcome;
  }

  /** What the buffer holds and counted — the trace_retro_* metrics. */
  usage(): RetroUsage {
    return {
      ...this.#arena.usage(),
      capacityBytes: this.#arena.allocatedBytes(),
      exported: this.#exported,
      unencodable: this.#unencodable,
      undecodable: this.#undecodable,
    };
  }
}

const TRIGGER_SOURCES = ["local", "remote"] as const;
const TRIGGER_OUTCOMES = ["accepted", "repeated", "rate_limited"] as const;

/** The trace_retro_* families of the buffer (metrics.registry.ts). */
export function registerRetroMetrics(meter: Meter, processor: RetroProcessor): void {
  // Stryker disable StringLiteral,ObjectLiteral: names, units and descriptions are held to
  // metrics.registry.ts by metrics.registry.spec.ts, which reads this source
  const bytes = meter.createObservableGauge("trace_retro_buffer_bytes", {
    description: "Bytes of the retroactive sampling buffer in use.",
    unit: "By",
  });
  const capacity = meter.createObservableGauge("trace_retro_buffer_capacity_bytes", {
    description: "Bytes the retroactive sampling buffer was allocated with: its limit.",
    unit: "By",
  });
  const spans = meter.createObservableGauge("trace_retro_buffer_spans", {
    description: "Unsampled spans kept for retroactive sampling.",
  });
  const horizon = meter.createObservableGauge("trace_retro_buffer_horizon_seconds", {
    description:
      "Time between the oldest and the newest span kept: how far back a trigger reaches.",
    unit: "s",
  });
  const spansTotal = meter.createObservableCounter("trace_retro_spans_total", {
    description:
      "Unsampled spans by what became of them: kept in the buffer, exported by a trigger, evicted by newer ones, or lost to the codec (unencodable, undecodable).",
  });
  const triggers = meter.createObservableCounter("trace_retro_triggers_total", {
    description:
      "Triggers of retroactive sampling: accepted, repeated for a trace already triggered, or refused by the rate limit; by a log line of this process (local) or asked for by another service (remote).",
  });
  // Stryker restore StringLiteral,ObjectLiteral
  meter.addBatchObservableCallback(
    (result) => {
      const use = processor.usage();
      result.observe(bytes, use.bytes);
      result.observe(capacity, use.capacityBytes);
      result.observe(spans, use.spans);
      result.observe(horizon, use.horizonSeconds);
      result.observe(spansTotal, use.kept, { outcome: "kept" });
      result.observe(spansTotal, use.exported, { outcome: "exported" });
      result.observe(spansTotal, use.evicted, { outcome: "evicted" });
      result.observe(spansTotal, use.unencodable, { outcome: "unencodable" });
      result.observe(spansTotal, use.undecodable, { outcome: "undecodable" });
      for (const source of TRIGGER_SOURCES) {
        for (const outcome of TRIGGER_OUTCOMES) {
          result.observe(triggers, use.triggers[source][outcome], { source, outcome });
        }
      }
    },
    [bytes, capacity, spans, horizon, spansTotal, triggers],
  );
}
