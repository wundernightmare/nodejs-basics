/**
 * CLIENT spans for Postgres queries — the pgx `otelpgx` tracer of the Go
 * sibling. Explicit wrapping instead of @opentelemetry/instrumentation-pg:
 * that one monkey-patches `pg` when it is first loaded, and in the Vite
 * bundle `pg` is already imported before instrumentation.ts runs, so it
 * would never fire.
 *
 * - every client of the pool is wrapped on its `connect` event, so a
 *   transaction's BEGIN / statements / COMMIT each get a span;
 * - `pool.query` is re-implemented as connect → client.query → release, so it
 *   gets one span (not a second one from pg-pool's internal client.query) and
 *   the span's parent is the caller's context even when the pool hands over a
 *   client released by another request.
 *
 * Only queries with an active parent span are traced: readiness probes and
 * pool metrics would otherwise open a root trace every few seconds.
 * Attribute names follow the OTel database semantic conventions; the query
 * text is the parameterised statement (values are never recorded).
 */
import {
  type Attributes,
  context,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import type { Pool, PoolClient, PoolConfig } from "pg";

const TRACER = "@base/database";
/** Longest db.query.text recorded; the rest is cut. */
const MAX_QUERY_TEXT = 2_048;

type QueryFn = (...args: unknown[]) => unknown;

/** Connection attributes shared by every span of one pool. */
export function pgTarget(options: PoolConfig): Attributes {
  const attrs: Attributes = { "db.system.name": "postgresql" };
  const url = options.connectionString;
  // libpq multi-host URLs (h1:5432,h2:5432) are not WHATWG URLs — take the
  // first host by hand rather than `new URL()`.
  const match =
    url === undefined
      ? null
      : /^[a-z]+:\/\/(?:[^@/]*@)?([^:/,?]+)(?::(\d+))?[^/]*\/([^?]*)/iu.exec(url);
  const host = match?.[1] ?? (typeof options.host === "string" ? options.host : undefined);
  const port = match?.[2] ?? options.port;
  const database = match?.[3] ?? options.database;
  if (host !== undefined && host !== "") attrs["server.address"] = decodeURIComponent(host);
  if (port !== undefined && port !== "") attrs["server.port"] = Number(port);
  if (database !== undefined && database !== "")
    attrs["db.namespace"] = decodeURIComponent(database);
  return attrs;
}

function queryText(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg;
  if (
    typeof arg === "object" &&
    arg !== null &&
    typeof (arg as { text?: unknown }).text === "string"
  ) {
    return (arg as { text: string }).text;
  }
  return undefined;
}

function startQuerySpan(text: string, target: Attributes): Span {
  const operation = /^\s*([a-z]+)/iu.exec(text)?.[1]?.toUpperCase();
  const namespace = target["db.namespace"];
  const attributes: Attributes = {
    ...target,
    "db.query.text": text.length > MAX_QUERY_TEXT ? text.slice(0, MAX_QUERY_TEXT) : text,
  };
  if (operation !== undefined) attributes["db.operation.name"] = operation;
  const name = [operation ?? "postgresql", namespace].filter((p) => p !== undefined).join(" ");
  return trace.getTracer(TRACER).startSpan(name, { kind: SpanKind.CLIENT, attributes });
}

function endSpan(span: Span, err?: unknown): void {
  if (err !== undefined && err !== null) {
    span.recordException(err instanceof Error ? err : JSON.stringify(err));
    span.setStatus({
      code: SpanStatusCode.ERROR,
      ...(err instanceof Error ? { message: err.message } : {}),
    });
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") span.setAttribute("db.response.status_code", code);
  }
  span.end();
}

function traceQuery(original: QueryFn, target: Attributes): QueryFn {
  return function tracedQuery(this: unknown, ...args: unknown[]): unknown {
    const text = queryText(args[0]);
    // Submittables (cursors, streams) and untraced callers pass straight through.
    const submittable = typeof (args[0] as { submit?: unknown } | null)?.submit === "function";
    if (text === undefined || submittable || trace.getSpan(context.active()) === undefined) {
      return original.apply(this, args);
    }
    const span = startQuerySpan(text, target);
    const spanContext = trace.setSpan(context.active(), span);
    const cbIndex = args.findIndex((a) => typeof a === "function");
    if (cbIndex !== -1) {
      const callback = args[cbIndex] as (err: unknown, res: unknown) => void;
      args[cbIndex] = (err: unknown, res: unknown): void => {
        endSpan(span, err);
        callback(err, res);
      };
      return context.with(spanContext, () => original.apply(this, args));
    }
    const result = context.with(spanContext, () => original.apply(this, args)) as Promise<unknown>;
    return result.then(
      (res) => {
        endSpan(span);
        return res;
      },
      (err: unknown) => {
        endSpan(span, err);
        throw err;
      },
    );
  };
}

/** Wraps `client.query` once; safe to call again on the same client. */
export function tracePgClient(client: PoolClient, target: Attributes): void {
  const marked = client as PoolClient & { __baseTraced?: true };
  if (marked.__baseTraced) return;
  marked.__baseTraced = true;
  const original = client.query.bind(client) as QueryFn;
  (client as unknown as { query: QueryFn }).query = traceQuery(original, target);
}

/** Traces every query issued through `pool` (see the module comment). */
export function tracePgPool(pool: Pool, target: Attributes): void {
  pool.on("connect", (client: PoolClient) => {
    tracePgClient(client, target);
  });
  const original = pool.query.bind(pool) as QueryFn;
  (pool as unknown as { query: QueryFn }).query = function pooledQuery(
    ...args: unknown[]
  ): unknown {
    // The callback form keeps pg-pool's own implementation (its internal
    // client.query is still traced, with whatever context pg-pool runs it in).
    if (args.some((a) => typeof a === "function")) return original(...args);
    return (async () => {
      const client = await pool.connect();
      tracePgClient(client, target);
      try {
        const result = await (client.query as unknown as QueryFn)(...args);
        client.release();
        return result;
      } catch (err) {
        // Like pg-pool: a failed query's client is released with the error,
        // which destroys it instead of returning a possibly broken connection.
        client.release(err as Error);
        throw err;
      }
    })();
  };
}
