import { Writable } from "node:stream";

import { FastifyOtelInstrumentation } from "@fastify/otel";
import { context, propagation, trace, type Tracer } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { CompositePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import Fastify, { type FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { registerRequestContext } from "@base/common";
import { bindTraceTrigger, buildPinoOptions, LogLevel } from "@base/logger";
import {
  type Collector,
  containerRuntimeAvailable,
  type Jaeger,
  meta,
  startCollector,
  startJaeger,
  type StoredSpan,
  testCase,
  unique,
} from "@base/testing";

import { DebugTokenPropagator } from "./debug-token-propagator.js";
import { type RetroOptions, RetroProcessor } from "./retro/retro-processor.js";
import { traceSampler } from "./trace-sampler.js";

/**
 * Head sampling, debug traces and the retroactive buffer, end to end: real
 * HTTP services — Fastify with @fastify/otel, the request-context hook, the
 * logger and the tracing pipeline setupTelemetry() builds (the sampler, the
 * buffer, the batch processor, the OTLP/gRPC exporter) — → the collector
 * this repository ships → a real Jaeger. Every assertion is on what Jaeger
 * stored and on the log lines the services wrote.
 *
 * Every service samples nothing at the head (ratio 0): whatever reaches
 * Jaeger got there because of a debug token or a trigger.
 *
 * Absence is proven without sleeping: a debug-token request, which is always
 * stored, is sent last through the same exporters; once Jaeger has it, the
 * fate of everything before it is decided.
 */
const runtime = await containerRuntimeAvailable();

const DEBUG_TOKEN = "integration-debug-token";

type Line = Record<string, unknown>;

interface Service {
  name: string;
  url: string;
  app: FastifyInstance;
  tracer: Tracer;
  retro: RetroProcessor;
  provider: BasicTracerProvider;
  logger: pino.Logger;
  /** Every line the service wrote, in order. */
  lines: Line[];
  /** The lines of one request, by its trace id (under either name). */
  linesOf(traceId: string): Line[];
}

interface ServiceOptions {
  trustRemoteParent?: boolean;
  retro?: Partial<RetroOptions>;
  routes(app: FastifyInstance, service: Service): void;
}

/** What a handler answers with: the ids a test looks for. */
function ids(): { traceId: string } {
  return { traceId: trace.getActiveSpan()?.spanContext().traceId ?? "" };
}

async function call(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; traceId: string; debugLogging: string | null }> {
  const res = await fetch(url, { headers });
  const body = (await res.json()) as { traceId: string };
  return {
    status: res.status,
    traceId: body.traceId,
    debugLogging: res.headers.get("x-debug-logging"),
  };
}

/** Calls another service the way an instrumented client does: with the trace context. */
async function relay(url: string): Promise<void> {
  const headers: Record<string, string> = {};
  propagation.inject(context.active(), headers);
  const res = await fetch(url, { headers });
  await res.arrayBuffer();
}

/** Whether every span of the trace has its parent in it: one tree, nothing missing. */
function wholeTree(spans: StoredSpan[]): boolean {
  const known = new Set(spans.map((s) => s.spanId));
  const roots = spans.filter((s) => s.parentSpanId === "");
  return (
    roots.length === 1 && spans.every((s) => s.parentSpanId === "" || known.has(s.parentSpanId))
  );
}

const message = (l: Line): unknown => l["message"];

/** What a client sends to be traced and logged at debug without being asked. */
const forged = (traceId: string): Record<string, string> => ({
  traceparent: `00-${traceId}-b7ad6b7169203331-01`,
  tracestate: "dbg=1,vendor=x",
});

describe.skipIf(!runtime)(
  "debug traces and retroactive sampling (integration)",
  { timeout: 90_000 },
  () => {
    meta({
      epic: "nodejs-basics",
      feature: "observability",
      owner: "@team-platform",
      tags: ["tracing", "sampling", "retroactive-sampling", "debug-trace", "integration"],
    });

    let jaeger: Jaeger;
    let collector: Collector;
    const started: Service[] = [];

    beforeAll(async () => {
      jaeger = await startJaeger();
      // Everything the services send is kept: what is stored is their decision.
      collector = await startCollector(jaeger, { baselinePercent: 100 });
      context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
      propagation.setGlobalPropagator(
        new CompositePropagator({
          propagators: [new W3CTraceContextPropagator(), new DebugTokenPropagator(DEBUG_TOKEN)],
        }),
      );
    }, 240_000);

    afterEach(async () => {
      bindTraceTrigger(undefined);
      await Promise.allSettled(
        started.splice(0).flatMap((s) => [s.app.close(), s.provider.shutdown()]),
      );
    });

    afterAll(async () => {
      propagation.disable();
      context.disable();
      await Promise.allSettled([collector?.stop(), jaeger?.stop()]);
    });

    /** A service as apps/api wires one, exporting to the collector, sampling nothing at the head. */
    async function start(prefix: string, options: ServiceOptions): Promise<Service> {
      const name = unique(prefix);
      const retro = new RetroProcessor(
        new BatchSpanProcessor(new OTLPTraceExporter({ url: collector.otlpGrpc })),
        { capacityBytes: 4 << 20, triggersPerSecond: 50, ...options.retro },
      );
      const provider = new BasicTracerProvider({
        resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: name }),
        sampler: traceSampler({
          ratio: "0",
          trustRemoteParent: options.trustRemoteParent ?? true,
          recordUnsampled: true,
        }),
        spanProcessors: [retro],
      });

      const lines: Line[] = [];
      const sink = new Writable({
        write(chunk: Buffer, _enc, cb) {
          for (const raw of chunk.toString().split("\n")) {
            if (raw.trim() !== "") lines.push(JSON.parse(raw) as Line);
          }
          cb();
        },
      });
      // The level of production: a debug line is seen only in a debug trace.
      const logger = pino(buildPinoOptions(new LogLevel("info")), sink);

      const app = Fastify({ logger: false });
      const otel = new FastifyOtelInstrumentation();
      registerInstrumentations({ tracerProvider: provider, instrumentations: [otel] });
      await app.register(otel.plugin() as never);
      registerRequestContext(app, { debugToken: DEBUG_TOKEN });

      const service: Service = {
        name,
        url: "",
        app,
        tracer: provider.getTracer("integration"),
        retro,
        provider,
        logger,
        lines,
        linesOf: (traceId) =>
          lines.filter((l) => l["trace.id"] === traceId || l["trace.unsampled_id"] === traceId),
      };
      // Every service has the request the suite ends a scenario with.
      app.get("/sentinel", async () => ids());
      options.routes(app, service);
      service.url = await app.listen({ port: 0, host: "127.0.0.1" });
      started.push(service);
      return service;
    }

    /**
     * Sends everything the services hold to the collector; then a request
     * that is always stored goes through each of them, and Jaeger is waited
     * for to have those. The collector decides traces in the order they
     * arrived, so what was sent before the sentinels and is not stored by
     * then never will be.
     */
    async function settled(...services: Service[]): Promise<void> {
      await Promise.all(services.map((s) => s.provider.forceFlush()));
      const sentinels: string[] = [];
      for (const service of services) {
        const sentinel = await call(`${service.url}/sentinel`, { "x-debug-token": DEBUG_TOKEN });
        sentinels.push(sentinel.traceId);
        await service.provider.forceFlush();
      }
      await expect
        .poll(
          async () => {
            const stored = await Promise.all(sentinels.map((traceId) => jaeger.trace(traceId)));
            return stored.every((spans) => spans.length > 0);
          },
          { timeout: 30_000 },
        )
        .toBe(true);
    }

    /**
     * The spans Jaeger has of a trace once it has all of them: one tree with
     * nothing missing that holds every span named. (The parts of a trace
     * reach it batch by batch, a service at a time.)
     */
    async function storedTrace(traceId: string, ...names: string[]): Promise<StoredSpan[]> {
      let spans: StoredSpan[] = [];
      await expect
        .poll(
          async () => {
            spans = await jaeger.trace(traceId);
            const have = new Set(spans.map((s) => s.operationName));
            return wholeTree(spans) && names.every((name) => have.has(name));
          },
          { timeout: 30_000 },
        )
        .toBe(true);
      return spans;
    }

    it("stores the whole trace of a request that logged a warning, and of no other", async () => {
      await testCase(
        "NB-1367",
        "Retroactive sampling: a warn line puts its unsampled trace into the trace store",
      );
      const api = await start("retro-api", {
        routes(app, service) {
          app.get("/ok", async () => {
            service.logger.info("handled");
            return ids();
          });
          app.get("/fail", async (_req, reply) => {
            // Ends before the trigger: waits in the buffer.
            service.tracer.startActiveSpan("load task", (span) => {
              span.setAttributes({ "task.id": "t-42", "task.attempt": 3, "cache.hit": false });
              span.addEvent("cache miss");
              span.end();
            });
            service.logger.info("loading");
            service.logger.warn("gave up");
            service.logger.info("cleaning up");
            // Ends after it: exported as it ends, and so is the server span.
            service.tracer.startActiveSpan("clean up", (span) => {
              span.end();
            });
            return reply.code(500).send(ids());
          });
        },
      });
      bindTraceTrigger(api.retro);

      const plain: string[] = [];
      for (let i = 0; i < 12; i++) plain.push((await call(`${api.url}/ok`)).traceId);
      const failed = await call(`${api.url}/fail`);
      expect(failed.status).toBe(500);
      for (let i = 0; i < 3; i++) plain.push((await call(`${api.url}/ok`)).traceId);
      await settled(api);

      // The span that ended before the warning, the one that ended after it,
      // the server span and what @fastify/otel hangs under it: one tree.
      const spans = await storedTrace(failed.traceId, "load task", "clean up");
      expect(spans.length).toBeGreaterThanOrEqual(3);
      expect(new Set(spans.map((s) => s.service))).toEqual(new Set([api.name]));
      // What waited in the buffer came out as it went in.
      const loaded = spans.find((s) => s.operationName === "load task");
      expect(loaded?.attributes).toMatchObject({
        "task.id": "t-42",
        "task.attempt": 3,
        "cache.hit": false,
      });
      expect(loaded?.events).toEqual(["cache miss"]);

      // The lines: found together by one id, a link from the warning on.
      expect(
        api
          .linesOf(failed.traceId)
          .map((l) => [message(l), l["trace.id"], l["trace.unsampled_id"]]),
      ).toEqual([
        ["loading", undefined, failed.traceId],
        ["gave up", failed.traceId, undefined],
        ["cleaning up", failed.traceId, undefined],
      ]);

      // Nothing else of this service is stored but the sentinel.
      const stored = await jaeger.traces(api.name);
      expect(stored).toHaveLength(2);
      for (const traceId of plain) {
        expect(await jaeger.trace(traceId)).toEqual([]);
        expect(api.linesOf(traceId).map((l) => l["trace.id"])).toEqual([undefined]);
      }
      // The spans of the requests that did not fail are still waiting for a reason.
      const usage = api.retro.usage();
      expect(usage.triggers.local).toEqual({ accepted: 1, repeated: 0, rate_limited: 0 });
      expect(usage.exported).toBe(spans.length);
      expect(usage.spans).toBeGreaterThanOrEqual(plain.length);
      expect(usage.undecodable + usage.unencodable + usage.evicted).toBe(0);
    });

    it("lets out no more failing traces a second than its rate, and links only those", async () => {
      await testCase(
        "NB-1368",
        "Retroactive sampling: the trigger rate bounds the export under a storm of errors",
      );
      const api = await start("retro-storm", {
        // A clock that stands still: the whole storm is one second.
        retro: { triggersPerSecond: 3, now: () => 0 },
        routes(app, service) {
          app.get("/fail", async (_req, reply) => {
            service.logger.error("failed");
            return reply.code(500).send(ids());
          });
        },
      });
      bindTraceTrigger(api.retro);

      const failed = await Promise.all(Array.from({ length: 10 }, () => call(`${api.url}/fail`)));
      await settled(api);

      const linked = api.lines.filter(
        (l) => message(l) === "failed" && l["trace.id"] !== undefined,
      );
      const unlinked = api.lines.filter(
        (l) => message(l) === "failed" && l["trace.unsampled_id"] !== undefined,
      );
      expect([linked.length, unlinked.length]).toEqual([3, 7]);
      // A link is never dead, and what is not linked is not stored.
      for (const { traceId } of failed) {
        if (linked.some((l) => l["trace.id"] === traceId)) await storedTrace(traceId);
        else expect(await jaeger.trace(traceId)).toEqual([]);
      }
      expect(await jaeger.traces(api.name)).toHaveLength(4); // three and the sentinel
      expect(api.retro.usage().triggers.local).toEqual({
        accepted: 3,
        repeated: 0,
        rate_limited: 7,
      });
    });

    /** An internet-facing edge in front of a backend that trusts it. */
    async function pipeline(): Promise<{ edge: Service; backend: Service }> {
      const backend = await start("backend", {
        trustRemoteParent: true,
        routes(app, service) {
          app.get("/work", async () => {
            service.logger.debug("backend detail");
            service.logger.info("backend worked");
            service.tracer.startActiveSpan("backend query", (span) => {
              span.end();
            });
            return ids();
          });
          app.get("/break", async (_req, reply) => {
            service.tracer.startActiveSpan("backend query", (span) => {
              span.end();
            });
            service.logger.error("backend broke");
            return reply.code(500).send(ids());
          });
        },
      });
      const edge = await start("edge", {
        trustRemoteParent: false,
        routes(app, service) {
          for (const path of ["work", "break"]) {
            app.get(`/${path}`, async () => {
              service.logger.debug("edge detail");
              service.tracer.startActiveSpan("edge prepare", (span) => {
                span.end();
              });
              await relay(`${backend.url}/${path}`);
              service.logger.info("edge relayed");
              return ids();
            });
          }
        },
      });
      return { edge, backend };
    }

    it("traces and logs a request with the debug token through every service, at ratio 0", async () => {
      await testCase(
        "NB-1369",
        "Debug trace: X-Debug-Token samples the request and opens debug logs in every service",
      );
      const { edge, backend } = await pipeline();

      const plain = await call(`${edge.url}/work`);
      const wrong = await call(`${edge.url}/work`, { "x-debug-token": "not-the-token" });
      const debugged = await call(`${edge.url}/work`, { "x-debug-token": DEBUG_TOKEN });
      expect([plain.debugLogging, wrong.debugLogging, debugged.debugLogging]).toEqual([
        null,
        null,
        "on",
      ]);
      await settled(edge, backend);

      // One trace with the spans of both services, the backend's under the edge's.
      const spans = await storedTrace(debugged.traceId, "edge prepare", "backend query");
      expect(new Set(spans.map((s) => s.service))).toEqual(new Set([edge.name, backend.name]));
      // The mark that carried the decision downstream.
      expect(new Set(spans.map((s) => s.traceState))).toEqual(new Set(["dbg=1"]));

      // Debug lines of both services, all linked to the trace — the backend
      // was never given the token.
      expect(edge.linesOf(debugged.traceId).map((l) => message(l))).toEqual([
        "edge detail",
        "edge relayed",
      ]);
      expect(backend.linesOf(debugged.traceId).map((l) => message(l))).toEqual([
        "backend detail",
        "backend worked",
      ]);
      for (const line of [
        ...edge.linesOf(debugged.traceId),
        ...backend.linesOf(debugged.traceId),
      ]) {
        expect(line["trace.id"]).toBe(debugged.traceId);
      }

      // Without the token, or with a wrong one: no trace, no debug lines, and
      // the lines of the two services still share an id.
      for (const { traceId } of [plain, wrong]) {
        expect(await jaeger.trace(traceId)).toEqual([]);
        expect(
          [...edge.linesOf(traceId), ...backend.linesOf(traceId)].map((l) => [
            message(l),
            l["trace.id"],
            l["trace.unsampled_id"],
          ]),
        ).toEqual([
          ["edge relayed", undefined, traceId],
          ["backend worked", undefined, traceId],
        ]);
      }
    });

    it("does not let a client of the edge decide: a forged traceparent and debug mark are not followed", async () => {
      await testCase(
        "NB-1370",
        "Public ingress: a client's sampled flag and debug mark do not reach the pipeline",
      );
      const { edge, backend } = await pipeline();

      const atEdge = "a1".repeat(16);
      const viaEdge = await call(`${edge.url}/work`, forged(atEdge));
      // The same headers straight to a service that trusts its callers: this
      // is what the edge keeps the internet away from.
      const atBackend = "b2".repeat(16);
      const direct = await call(`${backend.url}/work`, forged(atBackend));
      await settled(edge, backend);

      // The client keeps its trace id — and gets nothing else.
      expect(viaEdge.traceId).toBe(atEdge);
      expect(await jaeger.trace(atEdge)).toEqual([]);
      expect(
        [...edge.linesOf(atEdge), ...backend.linesOf(atEdge)].map((l) => [
          message(l),
          l["trace.id"],
          l["trace.unsampled_id"],
        ]),
      ).toEqual([
        ["edge relayed", undefined, atEdge],
        ["backend worked", undefined, atEdge],
      ]);

      expect(direct.traceId).toBe(atBackend);
      // (Its parent is the client's span, which nobody stored: not a whole tree.)
      await expect
        .poll(async () => (await jaeger.trace(atBackend)).map((s) => s.operationName))
        .toContain("backend query");
      const spans = await jaeger.trace(atBackend);
      expect(new Set(spans.map((s) => s.traceState))).toEqual(new Set(["dbg=1,vendor=x"]));
      expect(backend.linesOf(atBackend).map((l) => message(l))).toEqual([
        "backend detail",
        "backend worked",
      ]);
    });

    it("exports the part of a trace another service triggered once it is asked to", async () => {
      await testCase(
        "NB-1371",
        "Retroactive sampling across services: trigger() completes a trace triggered elsewhere",
      );
      const { edge, backend } = await pipeline();
      bindTraceTrigger(backend.retro);

      // The trigger is local: the backend's error stores the backend's spans.
      const alone = await call(`${edge.url}/break`);
      await settled(edge, backend);
      await expect
        .poll(async () => (await jaeger.trace(alone.traceId)).map((s) => s.operationName))
        .toContain("backend query");
      const partial = await jaeger.trace(alone.traceId);
      expect(new Set(partial.map((s) => s.service))).toEqual(new Set([backend.name]));

      // What a bus between the services does: tell the others what was
      // triggered here, and they export their part.
      const told: string[] = [];
      expect(
        backend.retro.onLocalTrigger((traceId) => {
          told.push(traceId);
          expect(edge.retro.trigger(traceId)).toBe("accepted");
        }),
      ).toBe(true);
      const together = await call(`${edge.url}/break`);
      await settled(edge, backend);

      expect(told).toEqual([together.traceId]);
      // The edge's span that ended before the backend failed came out of its
      // buffer; the ones still open came as they ended.
      const spans = await storedTrace(together.traceId, "edge prepare", "backend query");
      expect(new Set(spans.map((s) => s.service))).toEqual(new Set([edge.name, backend.name]));
      expect(edge.retro.usage().triggers.remote).toEqual({
        accepted: 1,
        repeated: 0,
        rate_limited: 0,
      });
      expect(backend.linesOf(together.traceId).map((l) => [message(l), l["trace.id"]])).toEqual([
        ["backend broke", together.traceId],
      ]);
    });
  },
);
