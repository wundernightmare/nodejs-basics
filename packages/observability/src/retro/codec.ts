/**
 * A finished span as text and back: what the arena keeps.
 *
 * The text is JSON of one flat array — the cheapest encoding there is in
 * Node (JSON.stringify and JSON.parse are native), and written into the
 * arena's bytes it leaves nothing on the heap. What does not travel with a
 * span: the trace id (the record header has it), the resource (one per
 * provider) and the instrumentation scope (a few per process, named by a
 * number).
 *
 * JSON has no NaN and no infinities: such an attribute value comes back
 * absent from an array or as null. Everything else an attribute may hold —
 * strings, finite numbers, booleans and arrays of them — is restored exactly.
 */
import {
  type Attributes,
  type HrTime,
  type Link,
  type SpanContext,
  type SpanKind,
  type SpanStatusCode,
  TraceFlags,
} from "@opentelemetry/api";
import { hrTimeDuration, type InstrumentationScope, TraceState } from "@opentelemetry/core";
import type { Resource } from "@opentelemetry/resources";
import type { ReadableSpan, TimedEvent } from "@opentelemetry/sdk-trace-base";

/** Scopes named by a number at most; the ones past it are written out. */
const SCOPES_MAX = 256;

type EncodedContext = [spanId: string, flags: number, remote: 0 | 1, state: string | 0];
type EncodedLink = [
  traceId: string,
  ...EncodedContext,
  attributes: Attributes | null,
  dropped: number | null,
];
type EncodedEvent = [
  name: string,
  seconds: number,
  nanos: number,
  attributes: Attributes | null,
  dropped: number | null,
];
type EncodedScope = number | [name: string, version: string | 0, schemaUrl: string | 0];
type EncodedSpan = [
  name: string,
  kind: SpanKind,
  self: EncodedContext,
  parent: EncodedContext | 0,
  startSeconds: number,
  startNanos: number,
  endSeconds: number,
  endNanos: number,
  statusCode: SpanStatusCode,
  statusMessage: string | 0,
  attributes: Attributes,
  links: EncodedLink[],
  events: EncodedEvent[],
  scope: EncodedScope,
  droppedAttributes: number,
  droppedEvents: number,
  droppedLinks: number,
];

function encodeContext(context: SpanContext): EncodedContext {
  return [
    context.spanId,
    context.traceFlags,
    context.isRemote === true ? 1 : 0,
    context.traceState?.serialize() ?? 0,
  ];
}

function decodeContext(
  traceId: string,
  [spanId, flags, remote, state]: EncodedContext,
): SpanContext {
  return {
    traceId,
    spanId,
    traceFlags: flags,
    ...(remote === 1 && { isRemote: true }),
    ...(state !== 0 && { traceState: new TraceState(state) }),
  };
}

function decodeLink([
  traceId,
  spanId,
  flags,
  remote,
  state,
  attributes,
  dropped,
]: EncodedLink): Link {
  const link: Link = { context: decodeContext(traceId, [spanId, flags, remote, state]) };
  if (attributes !== null) link.attributes = attributes;
  if (dropped !== null) link.droppedAttributesCount = dropped;
  return link;
}

function decodeEvent([name, seconds, nanos, attributes, dropped]: EncodedEvent): TimedEvent {
  const event: TimedEvent = { name, time: [seconds, nanos] };
  if (attributes !== null) event.attributes = attributes;
  if (dropped !== null) event.droppedAttributesCount = dropped;
  return event;
}

/** `span` as an exporter is given it: with the sampled flag, whatever the head decision was. */
export function asSampled(span: ReadableSpan): ReadableSpan {
  const own = span.spanContext();
  const context = { ...own, traceFlags: own.traceFlags | TraceFlags.SAMPLED };
  return {
    name: span.name,
    kind: span.kind,
    spanContext: () => context,
    ...(span.parentSpanContext !== undefined && { parentSpanContext: span.parentSpanContext }),
    startTime: span.startTime,
    endTime: span.endTime,
    status: span.status,
    attributes: span.attributes,
    links: span.links,
    events: span.events,
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

export class SpanCodec {
  readonly #scopes: InstrumentationScope[] = [];
  readonly #scopeIds = new Map<InstrumentationScope, number>();

  #encodeScope(scope: InstrumentationScope): EncodedScope {
    const known = this.#scopeIds.get(scope);
    if (known !== undefined) return known;
    if (this.#scopes.length >= SCOPES_MAX) {
      return [scope.name, scope.version ?? 0, scope.schemaUrl ?? 0];
    }
    this.#scopeIds.set(scope, this.#scopes.length);
    return this.#scopes.push(scope) - 1;
  }

  #decodeScope(scope: EncodedScope): InstrumentationScope | undefined {
    if (typeof scope === "number") return this.#scopes[scope];
    const [name, version, schemaUrl] = scope;
    return {
      name,
      ...(version !== 0 && { version }),
      ...(schemaUrl !== 0 && { schemaUrl }),
    };
  }

  /** The span as text. Throws on a span JSON cannot hold (it never should). */
  encode(span: ReadableSpan): string {
    const encoded: EncodedSpan = [
      span.name,
      span.kind,
      encodeContext(span.spanContext()),
      span.parentSpanContext === undefined ? 0 : encodeContext(span.parentSpanContext),
      span.startTime[0],
      span.startTime[1],
      span.endTime[0],
      span.endTime[1],
      span.status.code,
      span.status.message ?? 0,
      span.attributes,
      span.links.map((link): EncodedLink => [
        link.context.traceId,
        ...encodeContext(link.context),
        link.attributes ?? null,
        link.droppedAttributesCount ?? null,
      ]),
      span.events.map((event): EncodedEvent => [
        event.name,
        event.time[0],
        event.time[1],
        event.attributes ?? null,
        event.droppedAttributesCount ?? null,
      ]),
      this.#encodeScope(span.instrumentationScope),
      span.droppedAttributesCount,
      span.droppedEventsCount,
      span.droppedLinksCount,
    ];
    return JSON.stringify(encoded);
  }

  /**
   * The span of `traceId` the bytes hold, as a sampled one; undefined when
   * they are not what encode() wrote.
   */
  decode(payload: Buffer, traceId: string, resource: Resource): ReadableSpan | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.toString());
    } catch {
      // Not JSON: `parsed` stays undefined and is refused below.
    }
    if (!Array.isArray(parsed) || parsed.length !== 17) return undefined;
    const [
      name,
      kind,
      self,
      parent,
      startSeconds,
      startNanos,
      endSeconds,
      endNanos,
      statusCode,
      statusMessage,
      attributes,
      links,
      events,
      scope,
      droppedAttributesCount,
      droppedEventsCount,
      droppedLinksCount,
    ] = parsed as EncodedSpan;
    const instrumentationScope = this.#decodeScope(scope);
    if (instrumentationScope === undefined) return undefined;

    const own = decodeContext(traceId, self);
    const context = { ...own, traceFlags: own.traceFlags | TraceFlags.SAMPLED };
    const startTime: HrTime = [startSeconds, startNanos];
    const endTime: HrTime = [endSeconds, endNanos];
    return {
      name,
      kind,
      spanContext: () => context,
      ...(parent !== 0 && { parentSpanContext: decodeContext(traceId, parent) }),
      startTime,
      endTime,
      status: { code: statusCode, ...(statusMessage !== 0 && { message: statusMessage }) },
      attributes,
      links: links.map((link) => decodeLink(link)),
      events: events.map((event) => decodeEvent(event)),
      duration: hrTimeDuration(startTime, endTime),
      ended: true,
      resource,
      instrumentationScope,
      droppedAttributesCount,
      droppedEventsCount,
      droppedLinksCount,
    };
  }
}
