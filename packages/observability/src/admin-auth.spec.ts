import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { requireBearer } from "./admin-auth.js";

/** Serves one guarded handler on an ephemeral port. */
function serve(
  token: string,
  warn = vi.fn(),
): Promise<{ url: string; close: () => void; warn: typeof warn }> {
  const guard = requireBearer(token, { warn });
  const server = http.createServer((req, res) => {
    if (!guard(req, res)) return;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/admin/log-level`,
        close: () => server.close(),
        warn,
      });
    });
  });
}

describe("requireBearer", () => {
  let guarded: Awaited<ReturnType<typeof serve>>;
  let open: Awaited<ReturnType<typeof serve>>;

  beforeAll(async () => {
    guarded = await serve("s3cret");
    open = await serve("");
  });
  afterAll(() => {
    guarded.close();
    open.close();
  });

  it("rejects a missing token with 401 problem+json and WWW-Authenticate, logging at warn", async () => {
    const res = await fetch(guarded.url, { method: "PUT" });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="admin"');
    expect(await res.json()).toMatchObject({
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      detail: "a valid Authorization: Bearer <ADMIN_TOKEN> header is required",
      instance: "/admin/log-level",
    });
    expect(guarded.warn).toHaveBeenCalledWith(
      expect.objectContaining({ "http.request.method": "PUT", "url.path": "/admin/log-level" }),
      "Admin: rejected unauthenticated mutation",
    );
  });

  it("rejects a wrong token, a wrong length and a non-Bearer scheme", async () => {
    for (const authorization of [
      "Bearer s3creT",
      "Bearer s3cret-but-longer",
      "Basic s3cret",
      "s3cret",
    ]) {
      const res = await fetch(guarded.url, { method: "PUT", headers: { authorization } });
      expect(res.status, authorization).toBe(401);
    }
  });

  it("lets a matching token through", async () => {
    const res = await fetch(guarded.url, {
      method: "PUT",
      headers: { authorization: "Bearer s3cret" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("is a no-op when no token is configured", async () => {
    const res = await fetch(open.url, { method: "PUT" });
    expect(res.status).toBe(200);
    expect(open.warn).not.toHaveBeenCalled();
  });
});
