import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, TraceFlags } from "@opentelemetry/api";
import { TraceState } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  AlwaysOnSampler,
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { testCase } from "@base/testing";

import { asSampled, SpanCodec } from "./codec.js";

const resource = resourceFromAttributes({ "service.name": "codec-test" });

function finished(
  build: (tracer: ReturnType<BasicTracerProvider["getTracer"]>) => void,
): ReadableSpan[] {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    resource,
    sampler: new AlwaysOnSampler(),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  build(provider.getTracer("codec", "1.2.3", { schemaUrl: "https://example.test/schema" }));
  return exporter.getFinishedSpans();
}

/** Everything an exporter reads of a span, as plain data. */
function view(span: ReadableSpan) {
  return {
    name: span.name,
    kind: span.kind,
    context: { ...span.spanContext(), traceState: span.spanContext().traceState?.serialize() },
    parent: span.parentSpanContext && {
      ...span.parentSpanContext,
      traceState: span.parentSpanContext.traceState?.serialize(),
    },
    startTime: span.startTime,
    endTime: span.endTime,
    duration: span.duration,
    ended: span.ended,
    status: span.status,
    attributes: span.attributes,
    links: span.links.map((l) => ({
      ...l,
      context: { ...l.context, traceState: l.context.traceState?.serialize() },
    })),
    events: span.events,
    scope: { ...span.instrumentationScope },
    resource: span.resource.attributes,
    dropped: [span.droppedAttributesCount, span.droppedEventsCount, span.droppedLinksCount],
  };
}

function roundTrip(codec: SpanCodec, span: ReadableSpan): ReadableSpan | undefined {
  return codec.decode(Buffer.from(codec.encode(span)), span.spanContext().traceId, resource);
}

describe("retroactive sampling codec", () => {
  it("restores a span with everything on it, as a sampled one", async () => {
    await testCase("NB-1355", "Retro buffer: a span survives the buffer unchanged");
    const [child, root] = finished((tracer) => {
      const remote = trace.setSpanContext(ROOT_CONTEXT, {
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "b7ad6b7169203331",
        traceFlags: TraceFlags.NONE,
        isRemote: true,
        traceState: new TraceState("vendor=x,dbg=1"),
      });
      const parent = tracer.startSpan(
        "GET /tasks/:id",
        {
          kind: SpanKind.SERVER,
          startTime: [1_763_200_000, 123_456_789],
          attributes: { "http.route": "/tasks/:id", "http.response.status_code": 500 },
          links: [
            {
              context: {
                traceId: "11111111111111111111111111111111",
                spanId: "2222222222222222",
                traceFlags: TraceFlags.SAMPLED,
                isRemote: true,
                traceState: new TraceState("k=v"),
              },
              attributes: { why: "batch" },
            },
          ],
        },
        remote,
      );
      const inner = tracer.startSpan(
        "SELECT tasks",
        { kind: SpanKind.CLIENT, startTime: [1_763_200_000, 200_000_000] },
        trace.setSpan(remote, parent),
      );
      inner.setAttributes({
        "db.rows": 3,
        ratio: 0.25,
        cached: false,
        tags: ["a", "b"],
        text: 'кавычки " и \\ и \n перевод строки 🙂',
      });
      inner.addEvent("retry", { attempt: 2 }, [1_763_200_000, 250_000_000]);
      inner.recordException(new Error("boom"), [1_763_200_000, 260_000_000]);
      inner.setStatus({ code: SpanStatusCode.ERROR, message: "boom" });
      inner.end([1_763_200_000, 300_000_000]);
      parent.end([1_763_200_001, 5]);
    }) as [ReadableSpan, ReadableSpan];

    const codec = new SpanCodec();
    for (const span of [child, root]) {
      const restored = roundTrip(codec, span);
      const expected = view(span);
      expected.context.traceFlags = TraceFlags.SAMPLED;
      expect(view(restored as ReadableSpan)).toEqual(expected);
    }
    // The scope is one object for all spans of a tracer, as before the buffer.
    expect((roundTrip(codec, child) as ReadableSpan).instrumentationScope).toBe(
      root.instrumentationScope,
    );
  });

  it("restores any attributes, names and times an instrumentation may record", () => {
    const value = fc.oneof(
      fc.string(),
      fc.boolean(),
      fc.integer(),
      fc.double({ noNaN: true, noDefaultInfinity: true }).filter((n) => !Object.is(n, -0)),
      fc.array(fc.string(), { maxLength: 4 }),
      fc.array(fc.integer(), { maxLength: 4 }),
    );
    const key = fc.string({ minLength: 1, maxLength: 20 }).filter((k) => k !== "__proto__");
    fc.assert(
      fc.property(
        fc.string(),
        fc.dictionary(key, value, { maxKeys: 8 }),
        fc.array(fc.tuple(fc.string(), fc.dictionary(key, value, { maxKeys: 3 })), {
          maxLength: 3,
        }),
        fc.constantFrom(...Object.values(SpanKind).filter((k) => typeof k === "number")),
        fc.nat(4_000_000_000),
        fc.nat(999_999_999),
        fc.nat(86_400),
        (name, attributes, events, kind, seconds, nanos, lasted) => {
          const [span] = finished((tracer) => {
            const s = tracer.startSpan(name, { kind, attributes, startTime: [seconds, nanos] });
            for (const [eventName, eventAttributes] of events) {
              s.addEvent(eventName, eventAttributes, [seconds, nanos]);
            }
            s.end([seconds + lasted, nanos]);
          });
          const restored = roundTrip(new SpanCodec(), span as ReadableSpan);
          const expected = view(span as ReadableSpan);
          expected.context.traceFlags = TraceFlags.SAMPLED;
          expect(view(restored as ReadableSpan)).toEqual(expected);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("writes a scope out once the table of scopes is full", () => {
    const codec = new SpanCodec();
    const spans = finished((tracer) => {
      tracer.startSpan("first").end();
    });
    // 256 scopes take the numbers; the next ones travel with their spans.
    const scopes = Array.from({ length: 300 }, (_, i) => ({
      name: `scope-${i}`,
      ...(i % 2 === 0 && { version: `v${i}` }),
      ...(i % 3 === 0 && { schemaUrl: `https://example.test/${i}` }),
    }));
    for (const [i, scope] of scopes.entries()) {
      const span = { ...asSampled(spans[0] as ReadableSpan), instrumentationScope: scope };
      const text = codec.encode(span);
      expect(text.includes(`scope-${i}`)).toBe(i >= 256);
      expect(
        codec.decode(Buffer.from(text), span.spanContext().traceId, resource)?.instrumentationScope,
      ).toEqual(scope);
    }
  });

  it("refuses bytes that are not a span instead of exporting garbage", () => {
    const codec = new SpanCodec();
    const [span] = finished((tracer) => {
      tracer.startSpan("ok").end();
    });
    const text = new SpanCodec().encode(span as ReadableSpan);
    const decode = (raw: string) => codec.decode(Buffer.from(raw), "0".repeat(31) + "1", resource);
    // A scope number this codec never gave out.
    expect(decode(text)).toBeUndefined();
    expect(decode(text.slice(0, -5))).toBeUndefined();
    expect(decode("{}")).toBeUndefined();
    expect(decode("[1,2,3]")).toBeUndefined();
    expect(decode("")).toBeUndefined();
  });

  it("exports a live span as sampled without touching the span itself", () => {
    const [span] = finished((tracer) => {
      const s = tracer.startSpan("live", { attributes: { a: 1 } });
      s.addEvent("e");
      s.end();
    }) as [ReadableSpan];
    const unsampled: ReadableSpan = {
      ...asSampled(span),
      spanContext: () => ({ ...span.spanContext(), traceFlags: TraceFlags.NONE }),
    };
    const exported = asSampled(unsampled);
    expect(exported.spanContext().traceFlags).toBe(TraceFlags.SAMPLED);
    expect(unsampled.spanContext().traceFlags).toBe(TraceFlags.NONE);
    const expected = view(span);
    expect(view(exported)).toEqual(expected);
  });

  it("restores links and events field for field, the absent ones absent", () => {
    const [base] = finished((tracer) => {
      tracer.startSpan("base").end();
    }) as [ReadableSpan];
    const linked = {
      traceId: "11111111111111111111111111111111",
      spanId: "2222222222222222",
      traceFlags: TraceFlags.NONE,
    };
    const span: ReadableSpan = {
      ...asSampled(base),
      links: [
        { context: linked },
        { context: { ...linked, isRemote: true }, attributes: {}, droppedAttributesCount: 3 },
      ],
      events: [
        { name: "bare", time: [1, 2] },
        { name: "full", time: [3, 4], attributes: { a: 1 }, droppedAttributesCount: 2 },
        { name: "zero", time: [5, 6], attributes: {}, droppedAttributesCount: 0 },
      ],
    };
    const restored = roundTrip(new SpanCodec(), span) as ReadableSpan;
    expect(restored.links).toStrictEqual(span.links);
    expect(restored.events).toStrictEqual(span.events);
    // A root has no parent — not a parent that is undefined.
    expect(Object.hasOwn(restored, "parentSpanContext")).toBe(false);
    expect(Object.hasOwn(asSampled(base), "parentSpanContext")).toBe(false);
  });

  it("names a scope by one number however many spans it has", () => {
    const codec = new SpanCodec();
    const [span] = finished((tracer) => {
      tracer.startSpan("same").end();
    }) as [ReadableSpan];
    const first = codec.encode(span);
    for (let i = 0; i < 300; i++) expect(codec.encode(span)).toBe(first);
    expect(first).not.toContain("codec");
  });
});
