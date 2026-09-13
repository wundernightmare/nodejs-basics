/**
 * RFC 9457 problem+json for the plain node:http admin server — the admin
 * counterpart of @base/common's problemDetail() (which this package cannot
 * import: it only depends on @base/logger). Titles come from node's own
 * STATUS_CODES, so an "about:blank" problem always carries the official
 * phrase; `request_id` is the id the admin server echoed in X-Request-Id.
 */
import { STATUS_CODES, type ServerResponse } from "node:http";

import { getRequestId } from "@base/logger";

export const PROBLEM_CONTENT_TYPE = "application/problem+json";

export interface AdminProblem {
  status: number;
  detail: string;
  /** The request path; filled by the admin server. */
  instance?: string;
  headers?: Record<string, string>;
}

export function writeProblem(res: ServerResponse, problem: AdminProblem): void {
  const requestId = getRequestId();
  const body = JSON.stringify({
    type: "about:blank",
    title: STATUS_CODES[problem.status] ?? "Error",
    status: problem.status,
    detail: problem.detail,
    ...(problem.instance !== undefined ? { instance: problem.instance } : {}),
    ...(requestId !== undefined ? { request_id: requestId } : {}),
  });
  res.writeHead(problem.status, {
    ...problem.headers,
    "Content-Type": PROBLEM_CONTENT_TYPE,
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}
