/**
 * Fastify wiring for the per-request context contract:
 *
 *   - X-Request-Id: honoured from the client when sane (see isValidRequestId),
 *     generated otherwise, echoed on the response, and put in
 *     AsyncLocalStorage so every log line (`http.request.id`), every outbound
 *     call (ResilientClient) and every problem+json body (`request_id`) of
 *     the request carries it.
 *   - X-Debug-Token: when a DEBUG_TOKEN is configured and the request carries
 *     it (constant-time compare), the request runs with debug logging on —
 *     every log line passes whatever the current level — and the response
 *     says so with `X-Debug-Logging: on`. A wrong or missing token is ignored
 *     silently: the API port is public and must not become an oracle.
 *
 * Usage in main.ts:
 *
 *   const adapter = new FastifyAdapter({ genReqId: genRequestId, ... });
 *   registerRequestContext(adapter.getInstance(), { debugToken: process.env.DEBUG_TOKEN });
 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { parseTimeoutMs, REQUEST_TIMEOUT_HEADER, withDeadline } from "../utils/deadline.js";
import { generateRequestId } from "../utils/nanoid.js";
import {
  DEBUG_LOGGING_HEADER,
  DEBUG_TOKEN_HEADER,
  REQUEST_ID_HEADER,
  debugLoggingStorage,
  isValidRequestId,
  requestIdStorage,
} from "../utils/request-context.js";

/** Fastify `genReqId`: the client's X-Request-Id when valid, else a fresh id. */
export function genRequestId(req: IncomingMessage): string {
  const header = req.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(header) ? header[0] : header;
  return isValidRequestId(candidate) ? candidate : generateRequestId();
}

/**
 * Constant-time equality of two secrets. Length is compared first (a length
 * leak is unavoidable with timingSafeEqual and harmless for a random token).
 */
export function secretEquals(got: string | undefined, want: string): boolean {
  if (got === undefined || got.length === 0) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface RequestContextOptions {
  /**
   * Value of the X-Debug-Token header that turns on debug logging for one
   * request. Empty/undefined disables the feature (no header is inspected).
   */
  debugToken?: string | undefined;
  /**
   * The budget of one request in ms (HTTP_REQUEST_TIMEOUT_MS): every outbound
   * call made while handling it gets at most what is left (utils/deadline.ts).
   * A caller's `x-request-timeout-ms` can shorten it, never extend it.
   * Unset → no deadline.
   */
  requestTimeoutMs?: number;
}

export function registerRequestContext(
  fastify: FastifyInstance,
  options: RequestContextOptions = {},
): void {
  const debugToken = options.debugToken ?? "";
  const budget = options.requestTimeoutMs;

  fastify.addHook("onRequest", (req: FastifyRequest, reply: FastifyReply, done: () => void) => {
    void reply.header(REQUEST_ID_HEADER, req.id);
    const asked = parseTimeoutMs(req.headers[REQUEST_TIMEOUT_HEADER]);
    const timeoutMs =
      budget === undefined ? asked : asked === undefined ? budget : Math.min(asked, budget);
    const run = (): void => {
      requestIdStorage.run(req.id, () => {
        if (debugToken === "") {
          done();
          return;
        }
        const raw = req.headers[DEBUG_TOKEN_HEADER];
        const got = Array.isArray(raw) ? raw[0] : raw;
        if (!secretEquals(got, debugToken)) {
          done();
          return;
        }
        void reply.header(DEBUG_LOGGING_HEADER, "on");
        debugLoggingStorage.run(true, () => {
          done();
        });
      });
    };
    if (timeoutMs === undefined) run();
    else withDeadline(timeoutMs, run);
  });
}
