/**
 * Bearer guard for the mutating admin endpoints (PUT/DELETE /admin/log-level,
 * POST /debug/*): `Authorization: Bearer <ADMIN_TOKEN>`, compared in
 * constant time. An empty token disables the guard — the local / compose
 * default — and the admin server's listening line says `auth=off` so it is
 * never a surprise in a cluster. Rejections are logged at warn: on the admin
 * listener they are either an operator with a stale token or something that
 * should not be there at all.
 *
 * Mirrors requireBearer in golang-basics' libs/httpx/admin.go.
 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { writeProblem } from "./admin-problem.js";

export interface GuardLogger {
  warn(obj: object, msg: string): void;
}

/** Returns true when the request may proceed; otherwise the 401 has been written. */
export type BearerGuard = (req: IncomingMessage, res: ServerResponse) => boolean;

export function requireBearer(token: string, logger: GuardLogger): BearerGuard {
  if (token === "") return () => true;
  const want = Buffer.from(token);

  return (req, res) => {
    const header = req.headers.authorization ?? "";
    const got = header.startsWith("Bearer ") ? Buffer.from(header.slice("Bearer ".length)) : null;
    if (got !== null && got.length === want.length && timingSafeEqual(got, want)) return true;

    const path = (req.url ?? "/").split("?")[0] ?? "/";
    logger.warn(
      {
        "http.request.method": req.method ?? "GET",
        "url.path": path,
        "client.address": req.socket?.remoteAddress ?? "unknown",
      },
      "Admin: rejected unauthenticated mutation",
    );
    writeProblem(res, {
      status: 401,
      detail: "a valid Authorization: Bearer <ADMIN_TOKEN> header is required",
      instance: path,
      headers: { "WWW-Authenticate": 'Bearer realm="admin"' },
    });
    return false;
  };
}
