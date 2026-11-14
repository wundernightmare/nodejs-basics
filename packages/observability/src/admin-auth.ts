/**
 * Bearer guard for the admin endpoints (everything under /admin/ and /debug/,
 * reads included): `Authorization: Bearer <ADMIN_TOKEN>`, compared in time
 * that depends on neither the token nor its length (Secret.equals). An empty token disables the guard — the local / compose
 * default — and the admin server's listening line says `auth=off` so it is
 * never a surprise in a cluster. Rejections are logged at warn: on the admin
 * listener they are either an operator with a stale token or something that
 * should not be there at all.
 *
 * Mirrors requireBearer in golang-basics' libs/httpx/admin.go.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { Secret } from "@base/logger";

import { writeProblem } from "./admin-problem.js";

export interface GuardLogger {
  warn(obj: object, msg: string): void;
}

/** Returns true when the request may proceed; otherwise the 401 has been written. */
export type BearerGuard = (req: IncomingMessage, res: ServerResponse) => boolean;

export function requireBearer(token: string | Secret, logger: GuardLogger): BearerGuard {
  const want = Secret.of(token);
  if (!want.isSet) return () => true;

  return (req, res) => {
    const header = req.headers.authorization ?? "";
    const got = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    if (want.equals(got)) return true;

    const path = (req.url ?? "/").split("?")[0] ?? "/";
    logger.warn(
      {
        "event.action": "admin.auth.rejected",
        "http.request.method": req.method ?? "GET",
        "url.path": path,
        "client.address": req.socket?.remoteAddress ?? "unknown",
      },
      "Admin: rejected unauthenticated request",
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
