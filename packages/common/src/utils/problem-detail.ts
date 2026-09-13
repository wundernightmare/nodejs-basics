import { getRequestId } from "./request-context.js";

export const PROBLEM_CONTENT_TYPE = "application/problem+json" as const;

/**
 * Standard HTTP status titles for RFC 9457 `title` field.
 * When `type` is "about:blank" the title MUST match the official HTTP phrase.
 */
export const HTTP_STATUS_TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

/** RFC 9457 body: the standard members plus any extension members. */
export interface ProblemDetail {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  [extension: string]: unknown;
}

/**
 * Builds an RFC 9457 problem body. `type` defaults to "about:blank" and
 * `title` to the HTTP phrase. The `request_id` extension is filled from the
 * current request context (when there is one) so an error body alone is
 * enough to find its log lines — mirroring httpx.AbortProblem in golang-basics.
 */
export function problemDetail(
  status: number,
  detail?: string,
  extensions: Record<string, unknown> = {},
): ProblemDetail {
  const requestId = getRequestId();
  return {
    ...(requestId !== undefined ? { request_id: requestId } : {}),
    ...extensions,
    type: "about:blank",
    title: HTTP_STATUS_TITLES[status] ?? "Error",
    status,
    ...(detail !== undefined ? { detail } : {}),
  };
}

/**
 * OpenAPI schema for RFC 9457 Problem Details (application/problem+json).
 * Use in @ApiXxxResponse({ content: { 'application/problem+json': { schema: PROBLEM_DETAIL_SCHEMA } } }).
 */
export const PROBLEM_DETAIL_SCHEMA = {
  type: "object",
  required: ["type", "title", "status"] as string[],
  properties: {
    type: {
      type: "string",
      format: "uri-reference",
      example: "about:blank",
      description:
        'URI identifying the problem type. "about:blank" denotes a generic HTTP error; ' +
        "more specific URIs may identify application-level errors.",
    },
    title: {
      type: "string",
      example: "Not Found",
      description: "Short, human-readable summary of the problem type.",
    },
    status: {
      type: "integer",
      example: 404,
      description: "HTTP status code for this occurrence of the problem.",
    },
    detail: {
      type: "string",
      example: "The resource was not found.",
      description: "Human-readable explanation specific to this occurrence.",
    },
    instance: {
      type: "string",
      format: "uri-reference",
      example: "/resources/abc123",
      description: "URI reference identifying the specific occurrence of the problem.",
    },
    errorId: {
      type: "string",
      example: "X7K2P9M4",
      description:
        "Opaque identifier for this error occurrence. Correlates with server logs. " +
        "Include this when contacting support.",
    },
    request_id: {
      type: "string",
      example: "X7K2P9M4",
      description:
        "The request id echoed in the X-Request-Id response header. Every log line of " +
        "the request carries it (http.request.id).",
    },
  },
  additionalProperties: true,
} as const;
