import {
  type Context,
  type TextMapGetter,
  type TextMapPropagator,
  defaultTextMapGetter,
} from "@opentelemetry/api";

import { DEBUG_TOKEN_HEADER, forceTrace, Secret } from "@base/logger";

/**
 * Makes a request with the debug token a debug trace (@base/common,
 * utils/debug-trace.ts): where the context of an incoming request is
 * extracted — before its server span starts, which is when the sampler
 * decides — a valid X-Debug-Token marks the context with forceTrace().
 *
 * A propagator because that is the one step every server instrumentation
 * runs before it starts the span. It injects nothing: downstream the
 * decision travels in traceparent / tracestate.
 *
 * A wrong or missing token changes nothing, and the comparison takes the
 * same time whatever the values are (Secret.equals).
 */
export class DebugTokenPropagator implements TextMapPropagator {
  readonly #token: Secret;

  constructor(token: string | Secret | undefined) {
    this.#token = Secret.of(token);
  }

  inject(): void {
    // Nothing of its own travels.
  }

  extract(
    context: Context,
    carrier: unknown,
    getter: TextMapGetter = defaultTextMapGetter,
  ): Context {
    const raw = getter.get(carrier, DEBUG_TOKEN_HEADER);
    const got = Array.isArray(raw) ? raw[0] : raw;
    // An unset token equals nothing, and no token equals the empty string.
    return typeof got === "string" && this.#token.equals(got) ? forceTrace(context) : context;
  }

  fields(): string[] {
    return [];
  }
}
