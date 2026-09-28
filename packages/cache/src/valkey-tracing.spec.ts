import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Redis as Valkey } from "iovalkey";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { captureSpans, meta, testCase } from "@base/testing";

import { traceValkeyClient } from "./valkey-tracing.js";

const spans = captureSpans();

interface Cmd {
  name: string;
  promise: Promise<unknown>;
}

/** A client whose sendCommand records the command (no socket). */
function fakeClient(): { client: Valkey; sent: Cmd[] } {
  const sent: Cmd[] = [];
  const client = {
    options: { host: "cache.internal", port: 6380, db: 2 },
    sendCommand(command: Cmd) {
      sent.push(command);
      return command.promise;
    },
  } as unknown as Valkey;
  return { client: traceValkeyClient(client), sent };
}

const send = (client: Valkey, command: Cmd): unknown =>
  (client as unknown as { sendCommand(c: Cmd): unknown }).sendCommand(command);

const inSpan = <T>(fn: () => T): T =>
  trace.getTracer("test").startActiveSpan("parent", (span) => {
    try {
      return fn();
    } finally {
      span.end();
    }
  });

describe("valkey tracing", () => {
  meta({
    epic: "nodejs-basics",
    feature: "tracing",
    owner: "@team-platform",
    tags: ["cache", "tracing", "unit"],
  });

  beforeEach(() => {
    spans.reset();
  });
  afterAll(() => {
    spans.stop();
  });

  it("wraps a command issued inside a span in a CLIENT span without its arguments", async () => {
    await testCase("NB-321", "GET → CLIENT span `GET`, target attributes, no key");
    const { client, sent } = fakeClient();
    const command = { name: "get", promise: Promise.resolve("v"), args: ["user:secret"] };
    inSpan(() => send(client, command));
    await command.promise;
    await Promise.resolve();

    expect(sent).toHaveLength(1);
    const span = spans.span("GET");
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes).toEqual({
      "db.system.name": "valkey",
      "db.operation.name": "GET",
      "db.namespace": "2",
      "server.address": "cache.internal",
      "server.port": 6380,
    });
    expect(span.parentSpanContext?.spanId).toBe(spans.span("parent").spanContext().spanId);
  });

  it("does not trace commands without a parent span, nor a re-sent command twice", async () => {
    await testCase("NB-322", "readiness PINGs stay untraced; offline-queue replay adds no span");
    const { client, sent } = fakeClient();
    send(client, { name: "ping", promise: Promise.resolve("PONG") });
    const replayed = { name: "set", promise: Promise.resolve("OK") };
    inSpan(() => send(client, replayed));
    inSpan(() => send(client, replayed));
    await Promise.resolve();
    await Promise.resolve();

    expect(sent).toHaveLength(3);
    expect(spans.spans().filter((s) => s.name === "SET")).toHaveLength(1);
    expect(spans.spans().some((s) => s.name === "PING")).toBe(false);
  });

  it("fails the span when the command is rejected", async () => {
    await testCase("NB-323", "a WRONGTYPE reply is a failed span");
    const { client } = fakeClient();
    const command = { name: "incr", promise: Promise.reject(new Error("WRONGTYPE")) };
    command.promise.catch(() => undefined);
    inSpan(() => send(client, command));
    await command.promise.catch(() => undefined);
    await Promise.resolve();

    const span = spans.span("INCR");
    expect(span.status).toMatchObject({ code: SpanStatusCode.ERROR, message: "WRONGTYPE" });
  });
});
