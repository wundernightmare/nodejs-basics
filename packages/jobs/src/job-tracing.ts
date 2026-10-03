/**
 * Trace-context propagation through BullMQ jobs, without BullMQ's own
 * `telemetry` option: that one (bullmq-otel) also traces the worker's
 * internal loops — a root span per `getNextJob` poll and stalled-job check.
 *
 * The carrier travels in the job's `opts.telemetry.metadata` — the field
 * BullMQ reserves for exactly this and persists with the job — so job data
 * stays the caller's payload.
 *
 *   enqueue:  addTraced(queue, name, data, opts) → PRODUCER span `send <queue>`
 *   process:  traceJob(job, fn)                  → CONSUMER span `process <queue>`,
 *             a child of the enqueuing span
 */
import {
  type Attributes,
  context,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import type { Job, JobsOptions, Queue } from "bullmq";

const TRACER = "@base/jobs";

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

function carrierOf(job: Job): Record<string, string> {
  const metadata = job.opts.telemetry?.metadata;
  if (metadata === undefined || metadata === "") return {};
  try {
    const parsed: unknown = JSON.parse(metadata);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** `send` inside a PRODUCER span; `fn` gets the carrier to store with the job. */
export function traceSend<T>(
  system: string,
  queue: string,
  id: string | undefined,
  fn: (carrier: Record<string, string>) => Promise<T>,
): Promise<T> {
  const attributes: Attributes = {
    "messaging.system": system,
    "messaging.operation.type": "send",
    "messaging.operation.name": "send",
    "messaging.destination.name": queue,
  };
  if (id !== undefined) attributes["messaging.message.id"] = id;
  return trace
    .getTracer(TRACER)
    .startActiveSpan(`send ${queue}`, { kind: SpanKind.PRODUCER, attributes }, async (span) => {
      const carrier: Record<string, string> = {};
      propagation.inject(context.active(), carrier);
      try {
        const result = await fn(carrier);
        endSpan(span);
        return result;
      } catch (err) {
        endSpan(span, err);
        throw err;
      }
    });
}

/** `fn` inside a CONSUMER span parented on the context the producer stored with the job. */
export function traceProcess<T>(
  system: string,
  queue: string,
  id: string | undefined,
  carrier: Record<string, string>,
  extra: Attributes,
  fn: () => Promise<T>,
): Promise<T> {
  const parent = propagation.extract(context.active(), carrier);
  const attributes: Attributes = {
    "messaging.system": system,
    "messaging.operation.type": "process",
    "messaging.operation.name": "process",
    "messaging.destination.name": queue,
    ...extra,
  };
  if (id !== undefined) attributes["messaging.message.id"] = id;
  return trace
    .getTracer(TRACER)
    .startActiveSpan(
      `process ${queue}`,
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

/** `queue.add` inside a PRODUCER span whose context rides along with the job. */
export function addTraced(
  queue: Queue,
  name: string,
  data: unknown,
  opts: JobsOptions = {},
): Promise<Job> {
  return traceSend("bullmq", queue.name, opts.jobId, (carrier) =>
    queue.add(name, data, {
      ...opts,
      telemetry: { ...opts.telemetry, metadata: JSON.stringify(carrier) },
    }),
  );
}

/** Run a BullMQ job's work inside a CONSUMER span parented on its producer. */
export function traceJob<T>(job: Job, fn: () => Promise<T>): Promise<T> {
  return traceProcess(
    "bullmq",
    job.queueName,
    job.id,
    carrierOf(job),
    { "bullmq.job.name": job.name, "bullmq.job.attempts_made": job.attemptsMade },
    fn,
  );
}
