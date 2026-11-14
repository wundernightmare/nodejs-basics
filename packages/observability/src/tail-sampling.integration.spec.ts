import { readFile } from "node:fs/promises";

import { context, SpanStatusCode, trace, type Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type Collector,
  COLLECTOR_IMAGE,
  containerRuntimeAvailable,
  type Jaeger,
  JAEGER_IMAGE,
  meta,
  OBSERVABILITY_COMPOSE_PATH,
  startCollector,
  startJaeger,
  testCase,
  unique,
} from "@base/testing";

import { traceSampler } from "./trace-sampler.js";

/**
 * Tail sampling, end to end: the SDK the services run (the same sampler, the
 * same OTLP/gRPC exporter) → a real collector with the configuration this
 * repository ships → a real Jaeger. Each policy of
 * docker/otel-collector/config.yaml is asserted on what Jaeger stored.
 *
 * Absence is proven without sleeping: a sentinel trace that must be kept is
 * sent last; once it is stored, the decision for everything before it is in.
 *
 * The counterpart of golang-basics' libs/otelx/integration.
 */
const runtime = await containerRuntimeAvailable();

/** A service exporting to `collector`, sampling at the head like a real one. */
function service(collector: Collector, headRatio = "1") {
  const name = unique("svc");
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: name }),
    sampler: traceSampler(headRatio),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: collector.otlpGrpc }))],
  });
  return { name, provider, tracer: provider.getTracer("tail-sampling-test") };
}

/** One trace: a root and a child, `ms` long by its timestamps (nothing sleeps). */
function send(
  tracer: Tracer,
  name: string,
  shape: { ms?: number; error?: boolean; subject?: unknown } = {},
): void {
  const end = Date.now();
  const start = end - (shape.ms ?? 5);
  const root = tracer.startSpan(name, { startTime: start });
  const child = tracer.startSpan(
    `${name} child`,
    { startTime: start },
    trace.setSpan(context.active(), root),
  );
  if (shape.error === true) child.setStatus({ code: SpanStatusCode.ERROR, message: "boom" });
  if (shape.subject !== undefined) {
    child.setAttribute("debug.subject", shape.subject as string);
  }
  child.end(end);
  root.end(end);
}

describe.skipIf(!runtime)(
  "tail sampling in the collector (integration)",
  { timeout: 60_000 },
  () => {
    meta({
      epic: "nodejs-basics",
      feature: "observability",
      owner: "@team-platform",
      tags: ["tracing", "tail-sampling", "integration"],
    });

    let jaeger: Jaeger;
    let dropping: Collector; // baseline 0 %: only what a policy keeps
    let keeping: Collector; // baseline 100 %

    beforeAll(async () => {
      jaeger = await startJaeger();
      [dropping, keeping] = await Promise.all([
        startCollector(jaeger, { baselinePercent: 0 }),
        startCollector(jaeger, { baselinePercent: 100 }),
      ]);
    }, 240_000);

    afterAll(async () => {
      await Promise.allSettled([dropping?.stop(), keeping?.stop(), jaeger?.stop()]);
    });

    /** Root operation name → number of spans stored, once `sentinel` has arrived. */
    async function stored(serviceName: string, sentinel: string): Promise<Map<string, number>> {
      const read = async (): Promise<Map<string, number>> => {
        const found = new Map<string, number>();
        for (const t of await jaeger.traces(serviceName)) {
          const root = t.spans.find((s) => !s.operationName.endsWith(" child"));
          found.set(root?.operationName ?? "?", t.spans.length);
        }
        return found;
      };
      await expect.poll(async () => (await read()).has(sentinel), { timeout: 30_000 }).toBe(true);
      return read();
    }

    it("the collector under test is the one the stack runs", async () => {
      await testCase("NB-1273", "Tail sampling: the tested image is the shipped one");
      const compose = await readFile(OBSERVABILITY_COMPOSE_PATH, "utf8");
      expect(compose).toContain(`image: \${DOCKER_HUB:-docker.io}/${COLLECTOR_IMAGE}`);
      expect(compose).toContain(`image: \${DOCKER_HUB:-docker.io}/${JAEGER_IMAGE}`);
    });

    it("keeps every trace with an error, every slow one and every debug subject's — whole — and drops the rest", async () => {
      await testCase("NB-1274", "Tail sampling: errors, slow traces and debug.subject are kept");
      const { name, provider, tracer } = service(dropping);
      for (let i = 0; i < 40; i += 1) send(tracer, `plain ${i}`);
      for (let i = 0; i < 5; i += 1) send(tracer, `error ${i}`, { error: true });
      for (let i = 0; i < 5; i += 1) send(tracer, `slow ${i}`, { ms: 800 });
      // The attribute's presence is the signal: any value, any type.
      for (const [i, subject] of ["tenant-42", "tenant-42", "", 42].entries()) {
        send(tracer, `debug ${i}`, { subject });
      }
      send(tracer, "sentinel", { error: true });
      await provider.forceFlush();

      const kept = await stored(name, "sentinel");
      const expected = [
        ...Array.from({ length: 5 }, (_, i) => `error ${i}`),
        ...Array.from({ length: 5 }, (_, i) => `slow ${i}`),
        ...Array.from({ length: 4 }, (_, i) => `debug ${i}`),
        "sentinel",
      ].toSorted();
      expect([...kept.keys()].toSorted()).toEqual(expected);
      // Whole traces: the root came along with the child that carried the reason.
      expect([...kept.values()].every((spans) => spans === 2)).toBe(true);
      await provider.shutdown();
    });

    it("keeps the configured share of everything else", async () => {
      await testCase("NB-1275", "Tail sampling: the baseline share is configurable");
      const { name, provider, tracer } = service(keeping);
      for (let i = 0; i < 20; i += 1) send(tracer, `plain ${i}`);
      send(tracer, "sentinel", { error: true });
      await provider.forceFlush();

      const kept = await stored(name, "sentinel");
      expect(kept.size).toBe(21);
      await provider.shutdown();
    });

    it("only sees what the services send: head sampling below 1.0 hides errors from it", async () => {
      await testCase("NB-1276", "Tail sampling needs head sampling at 1.0");
      const unsampled = service(dropping, "0");
      const { name } = unsampled;
      for (let i = 0; i < 10; i += 1) send(unsampled.tracer, `error ${i}`, { error: true });
      await unsampled.provider.forceFlush();

      // The same service name at 1.0: its sentinel arrives, the ten errors never did.
      const sampled = new BasicTracerProvider({
        resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: name }),
        sampler: traceSampler("1"),
        spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: dropping.otlpGrpc }))],
      });
      send(sampled.getTracer("tail-sampling-test"), "sentinel", { error: true });
      await sampled.forceFlush();

      const kept = await stored(name, "sentinel");
      expect([...kept.keys()]).toEqual(["sentinel"]);
      await Promise.all([unsampled.provider.shutdown(), sampled.shutdown()]);
    });
  },
);
