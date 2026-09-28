import type { KafkaJS } from "@confluentinc/kafka-javascript";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { captureSpans, meta, testCase } from "@base/testing";

import { sendTraced, traceKafkaMessage } from "./kafka-tracing.js";

const spans = captureSpans();

type Sent = KafkaJS.ProducerRecord;

function fakeProducer(fail?: Error): { producer: KafkaJS.Producer; sent: Sent[] } {
  const sent: Sent[] = [];
  const send = vi.fn((record: Sent) => {
    sent.push(record);
    return fail === undefined ? Promise.resolve([]) : Promise.reject(fail);
  });
  return { producer: { send } as unknown as KafkaJS.Producer, sent };
}

function received(headers: KafkaJS.IHeaders | undefined): KafkaJS.KafkaMessage {
  return {
    key: Buffer.from("task-1"),
    value: Buffer.from("{}"),
    timestamp: "0",
    attributes: 0,
    offset: "42",
    headers,
  } as unknown as KafkaJS.KafkaMessage;
}

describe("kafka tracing", () => {
  meta({
    epic: "nodejs-basics",
    feature: "tracing",
    owner: "@team-platform",
    tags: ["kafka", "tracing", "unit"],
  });

  beforeEach(() => {
    spans.reset();
  });
  afterAll(() => {
    spans.stop();
  });

  it("sends inside a PRODUCER span and injects its context into the headers", async () => {
    await testCase("NB-401", "the record headers carry the producer span's traceparent");
    const { producer, sent } = fakeProducer();
    await sendTraced(producer, {
      topic: "tasks.events",
      messages: [{ key: "task-1", value: "{}", headers: { "x-request-id": "req-1" } }],
    });

    const span = spans.span("send tasks.events");
    expect(span.kind).toBe(SpanKind.PRODUCER);
    expect(span.attributes).toMatchObject({
      "messaging.system": "kafka",
      "messaging.operation.type": "send",
      "messaging.destination.name": "tasks.events",
      "messaging.kafka.message.key": "task-1",
    });
    const headers = sent[0]?.messages[0]?.headers ?? {};
    expect(headers["x-request-id"]).toBe("req-1");
    const { traceId, spanId } = span.spanContext();
    expect(headers["traceparent"]).toBe(`00-${traceId}-${spanId}-01`);
  });

  it("fails the span and re-throws when the send fails", async () => {
    await testCase("NB-402", "a failed send is a failed span");
    const { producer } = fakeProducer(new Error("broker down"));
    await expect(
      sendTraced(producer, { topic: "tasks.events", messages: [{ value: "a" }, { value: "b" }] }),
    ).rejects.toThrow("broker down");

    const span = spans.span("send tasks.events");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes["messaging.batch.message_count"]).toBe(2);
  });

  it("continues the producer's trace in the CONSUMER span", async () => {
    await testCase("NB-403", "process span is a child of the send span");
    const { producer, sent } = fakeProducer();
    await sendTraced(producer, { topic: "tasks.events", messages: [{ value: "{}" }] });
    const headers = sent[0]?.messages[0]?.headers;

    let activeTrace: string | undefined;
    await traceKafkaMessage(
      { topic: "tasks.events", partition: 0, message: received(headers), group: "tasks-worker" },
      () => {
        activeTrace = trace.getActiveSpan()?.spanContext().traceId;
        return Promise.resolve();
      },
    );

    const send = spans.span("send tasks.events");
    const process = spans.span("process tasks.events");
    expect(process.kind).toBe(SpanKind.CONSUMER);
    expect(process.spanContext().traceId).toBe(send.spanContext().traceId);
    expect(process.parentSpanContext?.spanId).toBe(send.spanContext().spanId);
    expect(activeTrace).toBe(send.spanContext().traceId);
    expect(process.attributes).toMatchObject({
      "messaging.consumer.group.name": "tasks-worker",
      "messaging.destination.partition.id": "0",
      "messaging.kafka.offset": 42,
    });
  });

  it("starts a new trace for a message without trace headers and records a handler failure", async () => {
    await testCase("NB-404", "no traceparent → root span; a throw fails it");
    await expect(
      traceKafkaMessage({ topic: "tasks.events", partition: 1, message: received(undefined) }, () =>
        Promise.reject(new Error("bad event")),
      ),
    ).rejects.toThrow("bad event");

    const process = spans.span("process tasks.events");
    expect(process.parentSpanContext).toBeUndefined();
    expect(process.status.code).toBe(SpanStatusCode.ERROR);
  });
});
