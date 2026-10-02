import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getIdentity, getRequestId, isDebugLogging, setActor } from "../utils/request-context.js";

import { genRequestId, registerRequestContext, secretEquals } from "./request-context.hooks.js";

describe("secretEquals", () => {
  it("compares in constant time on equal-length buffers and rejects everything else", () => {
    expect(secretEquals("s3cret", "s3cret")).toBe(true);
    expect(secretEquals("s3creT", "s3cret")).toBe(false);
    expect(secretEquals("s3cret-longer", "s3cret")).toBe(false);
    expect(secretEquals("", "s3cret")).toBe(false);
    expect(secretEquals(undefined, "s3cret")).toBe(false);
  });
});

describe("registerRequestContext", () => {
  const app = Fastify({ genReqId: genRequestId, logger: false });
  registerRequestContext(app, { debugToken: "dbg" });
  app.get("/", async () => ({ requestId: getRequestId(), debug: isDebugLogging() }));

  beforeAll(async () => {
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it("honours a valid client X-Request-Id, echoes it and puts it in the ALS context", async () => {
    const res = await app.inject({ url: "/", headers: { "x-request-id": "client-id-01" } });
    expect(res.headers["x-request-id"]).toBe("client-id-01");
    expect(res.json()).toEqual({ requestId: "client-id-01", debug: false });
  });

  it("replaces an invalid client id with a generated one", async () => {
    const res = await app.inject({ url: "/", headers: { "x-request-id": "bad id\n" } });
    const id = res.headers["x-request-id"];
    expect(typeof id).toBe("string");
    expect(id).not.toBe("bad id\n");
    expect(id).toMatch(/^[0-9A-Z]{8}$/);
    expect(res.json().requestId).toBe(id);
  });

  it("turns on debug logging for the request when X-Debug-Token matches", async () => {
    const res = await app.inject({ url: "/", headers: { "x-debug-token": "dbg" } });
    expect(res.headers["x-debug-logging"]).toBe("on");
    expect(res.json().debug).toBe(true);
  });

  it("ignores a wrong or missing token silently", async () => {
    const wrong = await app.inject({ url: "/", headers: { "x-debug-token": "nope" } });
    expect(wrong.statusCode).toBe(200);
    expect(wrong.headers["x-debug-logging"]).toBeUndefined();
    expect(wrong.json().debug).toBe(false);

    const missing = await app.inject({ url: "/" });
    expect(missing.headers["x-debug-logging"]).toBeUndefined();
    expect(missing.json().debug).toBe(false);
  });

  it("never inspects the header when no token is configured", async () => {
    const bare = Fastify({ genReqId: genRequestId, logger: false });
    registerRequestContext(bare);
    bare.get("/", async () => ({ debug: isDebugLogging() }));
    const res = await bare.inject({ url: "/", headers: { "x-debug-token": "" } });
    expect(res.headers["x-debug-logging"]).toBeUndefined();
    expect(res.json().debug).toBe(false);
    await bare.close();
  });
});

describe("request identity", () => {
  it("an actor set by a guard-like hook reaches the handler, and only for its own request", async () => {
    const app = Fastify({ genReqId: genRequestId, logger: false });
    registerRequestContext(app);
    // Like a Nest guard: runs in its own async frame before the handler.
    app.addHook("preHandler", async (req) => {
      await Promise.resolve();
      const user = req.headers["x-user"];
      if (typeof user === "string") setActor(user);
    });
    app.get("/", async () => getIdentity());

    expect((await app.inject({ url: "/", headers: { "x-user": "u1" } })).json()).toEqual({
      actor: "u1",
    });
    expect((await app.inject({ url: "/" })).json()).toEqual({});
    await app.close();
  });

  it("setActor outside a request has nowhere to write", () => {
    expect(setActor("u1")).toBe(false);
    expect(getIdentity()).toEqual({});
  });
});
