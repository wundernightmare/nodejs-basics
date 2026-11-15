import { context, metrics, type Span, trace, TraceFlags } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";

import { captureMetrics, metricValue, testCase } from "@base/testing";

import { traceSampler } from "../trace-sampler.js";

import { HEADER_BYTES } from "./arena.js";
import { asSampled, SpanCodec } from "./codec.js";
import { registerRetroMetrics, type RetroOptions, RetroProcessor } from "./retro-processor.js";

/** The pipeline setupTelemetry() builds, with an exporter that keeps what it is given. */
function service(options: Partial<RetroOptions> = {}, ratio = "0") {
  const exporter = new InMemorySpanExporter();
  const retro = new RetroProcessor(new SimpleSpanProcessor(exporter), {
    capacityBytes: 1 << 20,
    triggersPerSecond: 50,
    ...options,
  });
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ "service.name": "retro-test" }),
    sampler: traceSampler({ ratio, recordUnsampled: true }),
    spanProcessors: [retro],
  });
  const tracer = provider.getTracer("retro-test");
  return {
    retro,
    tracer,
    exported: () => exporter.getFinishedSpans().map((s) => s.name),
    spans: () => exporter.getFinishedSpans(),
    child: (parent: Span, name: string) =>
      tracer.startSpan(name, {}, trace.setSpan(context.active(), parent)),
  };
}

describe("RetroProcessor", () => {
  it("exports an unsampled trace once it is triggered: what ended before, and what ends after", async () => {
    await testCase("NB-1356", "Retroactive sampling: a trigger exports the whole unsampled trace");
    const { retro, tracer, child, exported, spans } = service();
    const root = tracer.startSpan("request");
    const traceId = root.spanContext().traceId;
    expect(root.spanContext().traceFlags).toBe(TraceFlags.NONE);
    expect(root.isRecording()).toBe(true);

    const query = child(root, "query");
    query.setAttribute("db.rows", 3);
    query.end();
    tracer.startSpan("another request").end();
    expect(exported()).toEqual([]);
    expect(retro.usage()).toMatchObject({ spans: 2, kept: 2, exported: 0 });
    expect(retro.isTriggered(traceId)).toBe(false);

    expect(retro.triggerByLog(traceId)).toBe(true);
    expect(exported()).toEqual(["query"]);
    expect(retro.isTriggered(traceId)).toBe(true);
    child(root, "publish").end();
    root.end();
    expect(exported()).toEqual(["query", "publish", "request"]);

    // One trace, parents intact, every span sampled for the exporter; the
    // span of the other request stayed where it was.
    for (const span of spans()) {
      expect(span.spanContext().traceId).toBe(traceId);
      expect(span.spanContext().traceFlags).toBe(TraceFlags.SAMPLED);
      expect(span.resource.attributes["service.name"]).toBe("retro-test");
    }
    const [first, second, last] = spans();
    expect(first?.attributes).toEqual({ "db.rows": 3 });
    expect(first?.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(second?.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(last?.parentSpanContext).toBeUndefined();
    expect(retro.usage()).toMatchObject({ spans: 1, kept: 2, exported: 3, undecodable: 0 });
    // The decision that travels downstream is unchanged.
    expect(root.spanContext().traceFlags).toBe(TraceFlags.NONE);
  });

  it("passes a sampled span straight on and keeps nothing of it", () => {
    const { retro, tracer, exported } = service({}, "1");
    tracer.startSpan("sampled").end();
    expect(exported()).toEqual(["sampled"]);
    expect(retro.usage()).toMatchObject({ spans: 0, kept: 0, exported: 0, bytes: 0 });
  });

  it("refuses the triggers above the rate: the trace stays unsampled", async () => {
    await testCase("NB-1357", "Retroactive sampling: a storm of errors is not a storm of exports");
    let now = 0;
    const { retro, tracer, exported } = service({ triggersPerSecond: 2, now: () => now });
    const ids = Array.from({ length: 4 }, (_, i) => {
      const span = tracer.startSpan(`failing ${i}`);
      span.end();
      return span.spanContext().traceId;
    });
    expect(ids.map((id) => retro.triggerByLog(id))).toEqual([true, true, false, false]);
    // A line of a trace triggered before may still link to it.
    expect(retro.triggerByLog(ids[0] as string)).toBe(true);
    expect(exported()).toEqual(["failing 0", "failing 1"]);
    expect(retro.isTriggered(ids[2] as string)).toBe(false);
    now = 1_000;
    expect(retro.triggerByLog(ids[2] as string)).toBe(true);
    expect(exported()).toEqual(["failing 0", "failing 1", "failing 2"]);
    expect(retro.usage().triggers.local).toEqual({ accepted: 3, repeated: 1, rate_limited: 2 });
  });

  it("exports a trace another service asks for, and tells a bus only what it triggered itself", async () => {
    await testCase("NB-1358", "Retroactive sampling: the entry and the exit for a bus");
    const { retro, tracer, exported } = service({ remoteTriggersPerSecond: 1 });
    const told: string[] = [];
    expect(retro.onLocalTrigger((id) => told.push(id))).toBe(true);
    expect(retro.onLocalTrigger(() => told.push("second observer"))).toBe(false);

    const asked = tracer.startSpan("asked for");
    asked.end();
    const own = tracer.startSpan("own");
    own.end();
    expect(retro.trigger(asked.spanContext().traceId)).toBe("accepted");
    expect(retro.trigger(asked.spanContext().traceId)).toBe("repeated");
    expect(retro.trigger("f".repeat(32))).toBe("rate_limited");
    expect(told).toEqual([]);

    expect(retro.triggerByLog(own.spanContext().traceId)).toBe(true);
    // Triggered already: nothing new to tell.
    expect(retro.triggerByLog(own.spanContext().traceId)).toBe(true);
    expect(retro.triggerByLog(asked.spanContext().traceId)).toBe(true);
    expect(told).toEqual([own.spanContext().traceId]);
    expect(exported()).toEqual(["asked for", "own"]);

    // What is not a trace id reaches neither the arena nor the counters.
    for (const bad of ["", "xyz", "0".repeat(32), "A".repeat(32), "f".repeat(33)]) {
      expect(retro.trigger(bad)).toBe("invalid");
      expect(retro.triggerByLog(bad)).toBe(false);
    }
    expect(retro.usage().triggers).toEqual({
      local: { accepted: 1, repeated: 2, rate_limited: 0 },
      remote: { accepted: 1, repeated: 1, rate_limited: 1 },
    });
  });

  it("does not keep a span that outgrows a shard, whatever its text is made of", () => {
    const { retro, tracer, exported } = service({ capacityBytes: 2_000, shards: 1 });
    const big = (name: string, text: string): string => {
      const span = tracer.startSpan(name);
      span.setAttribute("payload", text);
      span.end();
      return span.spanContext().traceId;
    };
    const ascii = big("ascii too long", "x".repeat(2_000));
    // 700 characters, three bytes each: only counting the bytes tells.
    const wide = big("wide too long", "€".repeat(700));
    expect(retro.usage()).toMatchObject({ spans: 0, kept: 0, evicted: 2 });
    const fits = big("wide that fits", "€".repeat(500));
    expect(retro.usage()).toMatchObject({ spans: 1, kept: 1, evicted: 2 });
    for (const id of [ascii, wide, fits]) retro.triggerByLog(id);
    expect(exported()).toEqual(["wide that fits"]);
    expect(retro.usage().bytes).toBe(0);
  });

  it("keeps a span that fills a shard to the byte, and not one byte more", () => {
    const spans: ReadableSpan[] = [];
    const provider = new BasicTracerProvider({
      sampler: traceSampler({ ratio: "0", recordUnsampled: true }),
      spanProcessors: [
        {
          onStart: () => undefined,
          onEnd: (span) => void spans.push(span),
          forceFlush: async () => undefined,
          shutdown: async () => undefined,
        },
      ],
    });
    const at = Date.UTC(2026, 0, 1);
    const span = provider.getTracer("t").startSpan("exact", { startTime: at });
    span.setAttribute("text", "€".repeat(100));
    span.end(at + 250);
    const [ended] = spans as [ReadableSpan];
    const size = HEADER_BYTES + Buffer.byteLength(new SpanCodec().encode(ended));

    const sink = new InMemorySpanExporter();
    const fits = new RetroProcessor(new SimpleSpanProcessor(sink), {
      capacityBytes: size,
      shards: 1,
      triggersPerSecond: 1,
    });
    fits.onEnd(ended);
    expect(fits.usage()).toMatchObject({ spans: 1, bytes: size, evicted: 0 });
    expect(fits.triggerByLog(ended.spanContext().traceId)).toBe(true);
    expect(sink.getFinishedSpans().map((s) => s.attributes)).toEqual([ended.attributes]);

    const short = new RetroProcessor(new SimpleSpanProcessor(sink), {
      capacityBytes: size - 1,
      shards: 1,
      triggersPerSecond: 1,
    });
    short.onEnd(ended);
    expect(short.usage()).toMatchObject({ spans: 0, bytes: 0, kept: 0, evicted: 1 });
  });

  it("measures the horizon by the end times of the spans, to the millisecond", () => {
    const { retro, tracer } = service({ shards: 1 });
    const at = Date.UTC(2026, 0, 1);
    tracer.startSpan("older", { startTime: at }).end(at + 250);
    tracer.startSpan("newer", { startTime: at }).end(at + 1_000);
    expect(retro.usage().horizonSeconds).toBe(0.75);
  });

  it("counts a span it cannot encode and goes on", () => {
    const { retro, tracer, exported } = service();
    const good = tracer.startSpan("good");
    good.end();
    const [template] = (() => {
      const kept: ReadableSpan[] = [];
      const provider = new BasicTracerProvider({
        sampler: traceSampler({ ratio: "0", recordUnsampled: true }),
        spanProcessors: [
          {
            onStart: () => undefined,
            onEnd: (span) => void kept.push(span),
            forceFlush: async () => undefined,
            shutdown: async () => undefined,
          },
        ],
      });
      provider.getTracer("t").startSpan("bad").end();
      return kept;
    })() as [ReadableSpan];
    // What no instrumentation should record, and JSON cannot hold.
    const bad = { ...asSampled(template), spanContext: () => template.spanContext() };
    Object.assign(bad, { attributes: { big: 10n } });
    expect(() => {
      retro.onEnd(bad);
    }).not.toThrow();
    expect(retro.usage()).toMatchObject({ unencodable: 1, kept: 1, spans: 1 });
    retro.triggerByLog(good.spanContext().traceId);
    expect(exported()).toEqual(["good"]);
  });

  it("forwards the lifecycle to the processor behind it", async () => {
    const calls: string[] = [];
    const retro = new RetroProcessor(
      {
        onStart: () => calls.push("start"),
        onEnding: () => calls.push("ending"),
        onEnd: () => calls.push("end"),
        forceFlush: async () => void calls.push("flush"),
        shutdown: async () => void calls.push("shutdown"),
      },
      { capacityBytes: 1 << 20, triggersPerSecond: 1 },
    );
    const provider = new BasicTracerProvider({
      sampler: traceSampler("1"),
      spanProcessors: [retro],
    });
    provider.getTracer("t").startSpan("s").end();
    await provider.forceFlush();
    await provider.shutdown();
    expect(calls).toEqual(["start", "ending", "end", "flush", "shutdown"]);
    // A processor without the optional hook is fine too.
    const plain = new RetroProcessor(new SimpleSpanProcessor(new InMemorySpanExporter()), {
      capacityBytes: 1 << 20,
      triggersPerSecond: 1,
    });
    const other = new BasicTracerProvider({ sampler: traceSampler("1"), spanProcessors: [plain] });
    expect(() => other.getTracer("t").startSpan("s").end()).not.toThrow();
  });

  it("reports the buffer and what became of the spans and the triggers", async () => {
    await testCase("NB-1359", "Retroactive sampling: the trace_retro_* metrics");
    const capture = captureMetrics();
    try {
      const { retro, tracer } = service({
        capacityBytes: 4_000,
        shards: 1,
        triggersPerSecond: 1,
        now: () => 0,
      });
      registerRetroMetrics(metrics.getMeter("retro"), retro);
      const read = async (name: string, labels?: Record<string, string>): Promise<number> =>
        metricValue(await capture.scrape(), name, labels);
      expect(await read("trace_retro_buffer_capacity_bytes")).toBe(4_000);
      expect(await read("trace_retro_buffer_bytes")).toBe(0);
      expect(await read("trace_retro_spans_total", { outcome: "kept" })).toBe(0);
      expect(
        await read("trace_retro_triggers_total", { source: "remote", outcome: "accepted" }),
      ).toBe(0);

      const ids: string[] = [];
      for (let i = 0; i < 40; i++) {
        const at = Date.UTC(2026, 0, 1) + i * 1_000;
        const span = tracer.startSpan(`span ${i}`, { startTime: at });
        span.end(at);
        ids.push(span.spanContext().traceId);
      }
      const held = await read("trace_retro_buffer_spans");
      expect(held).toBeGreaterThan(2);
      expect(held).toBeLessThan(40);
      expect(await read("trace_retro_buffer_bytes")).toBeLessThanOrEqual(4_000);
      expect(await read("trace_retro_buffer_bytes")).toBeGreaterThan(3_000);
      expect(await read("trace_retro_buffer_horizon_seconds")).toBe(held - 1);
      expect(await read("trace_retro_spans_total", { outcome: "kept" })).toBe(40);
      expect(await read("trace_retro_spans_total", { outcome: "evicted" })).toBe(40 - held);

      retro.triggerByLog(ids[39] as string);
      retro.triggerByLog(ids[39] as string);
      retro.triggerByLog(ids[38] as string);
      retro.trigger(ids[37] as string);
      const triggers = (source: string, outcome: string): Promise<number> =>
        read("trace_retro_triggers_total", { source, outcome });
      expect(await triggers("local", "accepted")).toBe(1);
      expect(await triggers("local", "repeated")).toBe(1);
      expect(await triggers("local", "rate_limited")).toBe(1);
      expect(await triggers("remote", "rate_limited")).toBe(1);
      expect(await read("trace_retro_spans_total", { outcome: "exported" })).toBe(1);
      expect(await read("trace_retro_spans_total", { outcome: "unencodable" })).toBe(0);
      expect(await read("trace_retro_spans_total", { outcome: "undecodable" })).toBe(0);
      expect(await read("trace_retro_buffer_spans")).toBe(held - 1);
    } finally {
      await capture.stop();
    }
  });
});
