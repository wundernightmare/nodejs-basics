import { context, createTraceState, ROOT_CONTEXT, trace, TraceFlags } from "@opentelemetry/api";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { captureSpans } from "@base/testing";

import { getRequestId, isDebugLogging } from "../utils/request-context.js";

import { genRequestId, registerRequestContext, secretEquals } from "./request-context.hooks.js";

describe("secretEquals", () => {
  it("compares in constant time on equal-length buffers and rejects everything else", () => {
    expect(secretEquals("s3cret", "s3cret")).toBe(true);
    expect(secretEquals("s3creT", "s3cret")).toBe(false);
    expect(secretEquals("s3cret-longer", "s3cret")).toBe(false);
    expect(secretEquals("", "s3cret")).toBe(false);
    expect(secretEquals(undefined, "s3cret")).toBe(false);
  });
});

describe("registerRequestContext", () => {
  const app = Fastify({ genReqId: genRequestId, logger: false });
  registerRequestContext(app, { debugToken: "dbg" });
  app.get("/", async () => ({ requestId: getRequestId(), debug: isDebugLogging() }));

  beforeAll(async () => {
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it("honours a valid client X-Request-Id, echoes it and puts it in the ALS context", async () => {
    const res = await app.inject({ url: "/", headers: { "x-request-id": "client-id-01" } });
    expect(res.headers["x-request-id"]).toBe("client-id-01");
    expect(res.json()).toEqual({ requestId: "client-id-01", debug: false });
  });

  it("replaces an invalid client id with a generated one", async () => {
    const res = await app.inject({ url: "/", headers: { "x-request-id": "bad id\n" } });
    const id = res.headers["x-request-id"];
    expect(typeof id).toBe("string");
    expect(id).not.toBe("bad id\n");
    expect(id).toMatch(/^[0-9A-Z]{8}$/u);
    expect(res.json().requestId).toBe(id);
  });

  it("turns on debug logging for the request when X-Debug-Token matches", async () => {
    const res = await app.inject({ url: "/", headers: { "x-debug-token": "dbg" } });
    expect(res.headers["x-debug-logging"]).toBe("on");
    expect(res.json().debug).toBe(true);
  });

  it("ignores a wrong or missing token silently", async () => {
    const wrong = await app.inject({ url: "/", headers: { "x-debug-token": "nope" } });
    expect(wrong.statusCode).toBe(200);
    expect(wrong.headers["x-debug-logging"]).toBeUndefined();
    expect(wrong.json().debug).toBe(false);

    const missing = await app.inject({ url: "/" });
    expect(missing.headers["x-debug-logging"]).toBeUndefined();
    expect(missing.json().debug).toBe(false);
  });

  it("never inspects the header when no token is configured", async () => {
    const bare = Fastify({ genReqId: genRequestId, logger: false });
    registerRequestContext(bare);
    bare.get("/", async () => ({ debug: isDebugLogging() }));
    const res = await bare.inject({ url: "/", headers: { "x-debug-token": "" } });
    expect(res.headers["x-debug-logging"]).toBeUndefined();
    expect(res.json().debug).toBe(false);
    await bare.close();
  });

  it("turns on debug logging for a request of a debug trace started upstream, without saying so", async () => {
    const capture = captureSpans();
    try {
      const traced = Fastify({ genReqId: genRequestId, logger: false });
      // What @fastify/otel does before this hook: the server span is active.
      traced.addHook("onRequest", (req, _reply, done) => {
        const [flags, tracestate] = String(req.headers["x-test-span"]).split(";");
        const spanContext = {
          traceId: "0af7651916cd43dd8448eb211c80319c",
          spanId: "b7ad6b7169203331",
          traceFlags: flags === "sampled" ? TraceFlags.SAMPLED : TraceFlags.NONE,
          traceState: createTraceState(tracestate),
        };
        context.with(trace.setSpanContext(ROOT_CONTEXT, spanContext), done);
      });
      registerRequestContext(traced, { debugToken: "dbg" });
      traced.get("/", async () => ({ debug: isDebugLogging() }));

      const ask = async (span: string) => {
        const res = await traced.inject({ url: "/", headers: { "x-test-span": span } });
        return { debug: res.json().debug as boolean, header: res.headers["x-debug-logging"] };
      };
      expect(await ask("sampled;dbg=1")).toEqual({ debug: true, header: undefined });
      expect(await ask("sampled;vendor=x")).toEqual({ debug: false, header: undefined });
      // The mark on a trace nobody samples is not a debug trace.
      expect(await ask("unsampled;dbg=1")).toEqual({ debug: false, header: undefined });
      await traced.close();
    } finally {
      capture.stop();
    }
  });
});
