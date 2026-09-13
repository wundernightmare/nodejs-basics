import { MethodNotAllowedException } from "@nestjs/common";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * 405 for a known path with an undeclared method (RFC 9110 §15.5.6, with the
 * `Allow` header). Fastify routes by (method, path) and answers 404 for both
 * an unknown path and an unknown method; Schemathesis' `unsupported_method`
 * check — and any client — wants the difference. The `onRoute` hook collects
 * every route NestJS registers; when a request falls through to the 404
 * handler (`request.is404`) and its path matches a collected route under
 * another method, the hook sets `Allow` and hands a MethodNotAllowedException
 * to the exception layer, so the body is the same problem+json every other
 * error gets. Register before `app.init()` — routes are collected as they
 * appear.
 */
export function registerMethodNotAllowed(fastify: FastifyInstance): void {
  const routes = new Map<string, { pattern: RegExp; methods: Set<string> }>();

  fastify.addHook("onRoute", (route) => {
    // A wildcard (e.g. @fastify/cors' `OPTIONS /*` preflight) says nothing
    // about which methods a concrete path supports.
    if (route.url.includes("*")) return;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    let entry = routes.get(route.url);
    if (!entry) {
      entry = { pattern: toPattern(route.url), methods: new Set() };
      routes.set(route.url, entry);
    }
    for (const m of methods) entry.methods.add(m.toUpperCase());
  });

  fastify.addHook(
    "onRequest",
    (request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => {
      if (!request.is404) {
        done();
        return;
      }
      const path = request.url.split("?")[0] ?? request.url;
      const allow = new Set<string>();
      for (const { pattern, methods } of routes.values()) {
        if (pattern.test(path)) for (const m of methods) allow.add(m);
      }
      if (allow.size === 0 || allow.has(request.method.toUpperCase())) {
        done();
        return;
      }
      const allowed = [...allow].toSorted().join(", ");
      void reply.header("Allow", allowed);
      done(
        new MethodNotAllowedException(
          `${request.method} is not allowed on ${path} (Allow: ${allowed})`,
        ),
      );
    },
  );
}

/** "/tasks/:id/archive" → /^\/tasks\/[^/]+\/archive$/ (Fastify's route syntax). */
function toPattern(url: string): RegExp {
  const source = url
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) return "[^/]+";
      if (segment === "*") return ".*";
      return segment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    })
    .join("/");
  return new RegExp(`^${source}/?$`, "u");
}
