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
    span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error | undefined)?.message });
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

/** `queue.add` inside a PRODUCER span whose context rides along with the job. */
export function addTraced(
  queue: Queue,
  name: string,
  data: unknown,
  opts: JobsOptions = {},
): Promise<Job> {
  const attributes: Attributes = {
    "messaging.system": "bullmq",
    "messaging.operation.type": "send",
    "messaging.operation.name": "send",
    "messaging.destination.name": queue.name,
  };
  if (opts.jobId !== undefined) attributes["messaging.message.id"] = opts.jobId;
  return trace
    .getTracer(TRACER)
    .startActiveSpan(
      `send ${queue.name}`,
      { kind: SpanKind.PRODUCER, attributes },
      async (span) => {
        const carrier: Record<string, string> = {};
        propagation.inject(context.active(), carrier);
        try {
          const job = await queue.add(name, data, {
            ...opts,
            telemetry: { ...opts.telemetry, metadata: JSON.stringify(carrier) },
          });
          endSpan(span);
          return job;
        } catch (err) {
          endSpan(span, err);
          throw err;
        }
      },
    );
}

/**
 * Runs a job processor inside a CONSUMER span `process <queue>`, parented on
 * the context `addTraced` stored with the job (a new trace otherwise).
 */
export function traceJob<T>(job: Job, fn: () => Promise<T>): Promise<T> {
  const parent = propagation.extract(context.active(), carrierOf(job));
  const attributes: Attributes = {
    "messaging.system": "bullmq",
    "messaging.operation.type": "process",
    "messaging.operation.name": "process",
    "messaging.destination.name": job.queueName,
    "bullmq.job.name": job.name,
    "bullmq.job.attempts_made": job.attemptsMade,
  };
  if (job.id !== undefined) attributes["messaging.message.id"] = job.id;
  return trace
    .getTracer(TRACER)
    .startActiveSpan(
      `process ${job.queueName}`,
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
