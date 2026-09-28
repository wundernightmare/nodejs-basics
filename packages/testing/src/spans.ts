import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

export interface SpanCapture {
  /** Every span ended so far, in end order. */
  spans(): ReadableSpan[];
  /** The ended span called `name`; throws when there is none. */
  span(name: string): ReadableSpan;
  /** Forget the spans captured so far. */
  reset(): void;
  /** Restore the no-op globals (call in afterAll / afterEach). */
  stop(): void;
}

/**
 * Real tracing for a test — the SDK the app runs (tracer provider, the
 * AsyncLocalStorage context manager, W3C propagation) with an in-memory
 * exporter, so a test asserts on span names, kinds, parents and attributes.
 * Installs process-wide globals: one capture per suite, `stop()` after it.
 */
export function captureSpans(): SpanCapture {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
  return {
    spans: () => exporter.getFinishedSpans(),
    span(name) {
      const found = exporter.getFinishedSpans().find((s) => s.name === name);
      if (found === undefined) {
        const names = exporter.getFinishedSpans().map((s) => s.name);
        throw new Error(`no span "${name}" (have: ${names.join(", ") || "none"})`);
      }
      return found;
    },
    reset: () => {
      exporter.reset();
    },
    stop: () => {
      trace.disable();
      propagation.disable();
      context.disable();
    },
  };
}
