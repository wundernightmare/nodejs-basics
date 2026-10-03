/**
 * CLIENT spans for Valkey commands — the `valkeyotel` wrapper of the Go
 * sibling. There is no OTel instrumentation for iovalkey (the ioredis one
 * patches the `ioredis` module only), and a patching one could not see a
 * module the Vite bundle imported before instrumentation.ts ran — so the
 * client's `sendCommand`, which every command goes through, is wrapped on
 * the instance.
 *
 * Only commands with an active parent span are traced (readiness PINGs and
 * the metrics gauges would otherwise open a root trace every few seconds).
 * Pipelines / MULTI are written by the pipeline itself and are not traced.
 * Arguments are never recorded — keys and values may carry user data; the
 * span says which command, not what it touched.
 */
import { type Attributes, context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Redis as Valkey } from "iovalkey";

const TRACER = "@base/cache";
const TRACED = Symbol("base.valkey.traced");

interface TracedCommand {
  name: string;
  promise: Promise<unknown>;
  [TRACED]?: true;
}

type SendCommand = (command: TracedCommand, stream?: unknown) => unknown;

/** Wraps `client.sendCommand` so each command runs in a span. */
export function traceValkeyClient(client: Valkey): Valkey {
  const target: Attributes = { "db.system.name": "valkey" };
  const { host, port, db } = client.options;
  if (host !== undefined) target["server.address"] = host;
  if (port !== undefined) target["server.port"] = port;
  if (db !== undefined) target["db.namespace"] = String(db);

  const original = client.sendCommand.bind(client) as unknown as SendCommand;
  const traced: SendCommand = (command, stream) => {
    // The offline queue re-sends a command once connected: one span is enough.
    if (command[TRACED] || trace.getSpan(context.active()) === undefined) {
      return original(command, stream);
    }
    command[TRACED] = true;
    const operation = command.name.toUpperCase();
    const span = trace.getTracer(TRACER).startSpan(operation, {
      kind: SpanKind.CLIENT,
      attributes: { ...target, "db.operation.name": operation },
    });
    command.promise.then(
      () => {
        span.end();
      },
      (err: unknown) => {
        span.recordException(err instanceof Error ? err : JSON.stringify(err));
        span.setStatus({
          code: SpanStatusCode.ERROR,
          ...(err instanceof Error ? { message: err.message } : {}),
        });
        span.end();
      },
    );
    return original(command, stream);
  };
  (client as unknown as { sendCommand: SendCommand }).sendCommand = traced;
  return client;
}
