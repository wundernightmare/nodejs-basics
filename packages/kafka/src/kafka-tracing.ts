/**
 * Trace-context propagation over Kafka record headers (W3C `traceparent` /
 * `tracestate` / `baggage`, whatever the global propagator writes).
 *
 *   producer:  KafkaProducerService.send() → PRODUCER span `send <topic>`,
 *              its context injected into every message's headers;
 *   consumer:  traceKafkaMessage() → CONSUMER span `process <topic>`, a child
 *              of the producing span, active while the handler runs.
 *
 * So one trace runs from the API request through the broker into the worker
 * (and on into BullMQ — see @base/jobs traceJob()). Explicit spans instead of
 * an instrumentation library on purpose: none exists for
 * @confluentinc/kafka-javascript, and monkey-patching instrumentations never
 * see a module the Vite bundle has already imported.
 *
 * Attribute names follow the OTel messaging semantic conventions.
 */
import type { KafkaJS } from "@confluentinc/kafka-javascript";
import {
  type Attributes,
  context,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  type TextMapGetter,
  type TextMapSetter,
  trace,
} from "@opentelemetry/api";

type KafkaHeaders = NonNullable<KafkaJS.Message["headers"]>;

const TRACER = "@base/kafka";

const headerSetter: TextMapSetter<KafkaHeaders> = {
  set(carrier, key, value) {
    carrier[key] = value;
  },
};

const headerGetter: TextMapGetter<KafkaHeaders | undefined> = {
  keys: (carrier) => (carrier === undefined ? [] : Object.keys(carrier)),
  get(carrier, key) {
    const value = carrier?.[key];
    const first = Array.isArray(value) ? value[0] : value;
    return first === undefined ? undefined : first.toString();
  },
};

/** Ends `span`, marking it failed when `err` is set. */
function endSpan(span: Span, err?: unknown): void {
  if (err !== undefined) {
    span.recordException(err instanceof Error ? err : JSON.stringify(err));
    span.setStatus({
      code: SpanStatusCode.ERROR,
      ...(err instanceof Error ? { message: err.message } : {}),
    });
  }
  span.end();
}

/**
 * Sends `record` inside a PRODUCER span and injects that span's context into
 * each message's headers (existing headers are kept).
 */
export function sendTraced(
  producer: KafkaJS.Producer,
  record: KafkaJS.ProducerRecord,
): Promise<KafkaJS.RecordMetadata[]> {
  const attributes: Attributes = {
    "messaging.system": "kafka",
    "messaging.operation.type": "send",
    "messaging.operation.name": "send",
    "messaging.destination.name": record.topic,
  };
  if (record.messages.length === 1) {
    const key = record.messages[0]?.key;
    if (key !== undefined && key !== null)
      attributes["messaging.kafka.message.key"] = key.toString();
  } else {
    attributes["messaging.batch.message_count"] = record.messages.length;
  }
  return trace
    .getTracer(TRACER)
    .startActiveSpan(
      `send ${record.topic}`,
      { kind: SpanKind.PRODUCER, attributes },
      async (span) => {
        const messages = record.messages.map((message) => {
          const headers: KafkaHeaders = { ...message.headers };
          propagation.inject(context.active(), headers, headerSetter);
          return { ...message, headers };
        });
        try {
          const result = await producer.send({ ...record, messages });
          endSpan(span);
          return result;
        } catch (err) {
          endSpan(span, err);
          throw err;
        }
      },
    );
}

export interface KafkaMessageContext {
  topic: string;
  partition: number;
  message: KafkaJS.KafkaMessage;
  /** Consumer group id, recorded as `messaging.consumer.group.name`. */
  group?: string;
}

/**
 * Runs `fn` inside a CONSUMER span `process <topic>` whose parent is the
 * context found in the message headers (a new trace when there is none).
 * A throw from `fn` marks the span failed and is re-thrown.
 */
export function traceKafkaMessage<T>(
  { topic, partition, message, group }: KafkaMessageContext,
  fn: () => Promise<T>,
): Promise<T> {
  const parent = propagation.extract(context.active(), message.headers, headerGetter);
  const attributes: Attributes = {
    "messaging.system": "kafka",
    "messaging.operation.type": "process",
    "messaging.operation.name": "process",
    "messaging.destination.name": topic,
    "messaging.destination.partition.id": String(partition),
    "messaging.kafka.offset": Number(message.offset),
  };
  if (group !== undefined) attributes["messaging.consumer.group.name"] = group;
  if (message.key !== undefined && message.key !== null) {
    attributes["messaging.kafka.message.key"] = message.key.toString();
  }
  return trace
    .getTracer(TRACER)
    .startActiveSpan(
      `process ${topic}`,
      { kind: SpanKind.CONSUMER, attributes },
      parent,
      async (span) => {
        try {
          const result = await fn();
          endSpan(span);
          return result;
        } catch (err) {
          endSpan(span, err);
          throw err;
        }
      },
    );
}
