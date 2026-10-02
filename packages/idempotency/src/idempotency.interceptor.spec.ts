/**
 * IdempotencyInterceptor — unit tests against an in-memory store.
 *
 * Covers the whole state machine: pass-through, UUID validation, replay of a
 * completed entry for the same request, 409 for a different request under
 * the same key, 409 while in flight (PROCESSING sentinel or a lost SET NX
 * race), eviction of a corrupted entry, lock release on handler error, and
 * fail-open when the store (Valkey) is unavailable.
 */
import {
  BadRequestException,
  type CallHandler,
  ConflictException,
  type ExecutionContext,
} from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import type { FastifyReply, FastifyRequest } from "fastify";
import { lastValueFrom, of, throwError } from "rxjs";
import { describe, expect, it, vi } from "vitest";

import type { AppLogger } from "@base/logger";
import { meta, testCase } from "@base/testing";

import { IdempotencyInterceptor } from "./idempotency.interceptor.js";
import type { IdempotencyStore } from "./idempotency.store.js";

const PROCESSING_SENTINEL = "__processing__";
const IDEM_UUID = "0b5f3c0e-8a52-4c4e-9a43-2f6d7c1e9b10";
const STORE_KEY = `idempotency:anon:${IDEM_UUID}`;
/** The route handler every request runs through: @HttpCode metadata lives on it. */
const handlerFn = (): void => {};

/** A Map-backed store with SET NX semantics; every method is a spy. */
function memoryStore(): IdempotencyStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: vi.fn((key: string) => Promise.resolve(data.get(key) ?? null)),
    set: vi.fn((key: string, value: string) => {
      data.set(key, value);
      return Promise.resolve();
    }),
    setNx: vi.fn((key: string, value: string) => {
      if (data.has(key)) return Promise.resolve(false);
      data.set(key, value);
      return Promise.resolve(true);
    }),
    del: vi.fn((key: string) => {
      data.delete(key);
      return Promise.resolve();
    }),
  };
}

interface RequestOpts {
  key?: string;
  userId?: string;
  method?: string;
  url?: string;
  body?: unknown;
  /** Handler outcome: a value, or an Error to fail with. */
  result?: unknown;
}

function setup(env: Record<string, string> = {}) {
  const store = memoryStore();
  const config = { get: (k: string) => env[k] } as unknown as ConfigService;
  const warn = vi.fn();
  const appLogger = { child: () => ({ warn }) } as unknown as AppLogger;
  const interceptor = new IdempotencyInterceptor(store, config, appLogger);
  Reflect.deleteMetadata("__httpCode__", handlerFn);

  function call(opts: RequestOpts = {}) {
    const request = {
      method: opts.method ?? "POST",
      url: opts.url ?? "/tasks",
      body: "body" in opts ? opts.body : { title: "a" },
      headers: opts.key === undefined ? {} : { "idempotency-key": opts.key },
      ...(opts.userId === undefined ? {} : { user: { userId: opts.userId } }),
    } as unknown as FastifyRequest;
    const header = vi.fn();
    const status = vi.fn();
    const reply = { header, status } as unknown as FastifyReply;
    const ctx = {
      getHandler: () => handlerFn,
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => reply }),
    } as unknown as ExecutionContext;
    const outcome = "result" in opts ? opts.result : { id: "created" };
    const handle = vi.fn(() =>
      outcome instanceof Error ? throwError(() => outcome) : of(outcome),
    );
    const next = { handle } as unknown as CallHandler;
    return {
      run: (): Promise<unknown> => lastValueFrom(interceptor.intercept(ctx, next)),
      handle,
      header,
      status,
    };
  }

  return { store, warn, call };
}

describe("IdempotencyInterceptor", () => {
  meta({
    epic: "nodejs-basics",
    feature: "idempotency",
    owner: "@team-platform",
    tags: ["idempotency", "unit"],
  });

  it("passes through untouched when the header is absent", async () => {
    await testCase("NB-807", "no Idempotency-Key → plain request");
    const { store, call } = setup();
    const req = call();

    await expect(req.run()).resolves.toEqual({ id: "created" });
    expect(req.handle).toHaveBeenCalledOnce();
    expect(store.get).not.toHaveBeenCalled();
  });

  it("rejects a key that is not a UUID with 400 before touching the store", async () => {
    await testCase("NB-808", "non-UUID key → 400");
    const { store, call } = setup();
    const req = call({ key: "not-a-uuid" });

    expect(() => req.run()).toThrow(BadRequestException);
    expect(req.handle).not.toHaveBeenCalled();
    expect(store.get).not.toHaveBeenCalled();
  });

  it("executes once and caches status, body and fingerprint under the user-scoped key", async () => {
    await testCase("NB-809", "first request runs the handler and is cached");
    const { store, call } = setup({ IDEMPOTENCY_TTL_SECONDS: "60" });
    Reflect.defineMetadata("__httpCode__", 201, handlerFn);
    const req = call({ key: IDEM_UUID, userId: "u1" });

    await expect(req.run()).resolves.toEqual({ id: "created" });

    expect(store.setNx).toHaveBeenCalledWith(
      `idempotency:u1:${IDEM_UUID}`,
      PROCESSING_SENTINEL,
      30,
    );
    expect(store.set).toHaveBeenCalledWith(`idempotency:u1:${IDEM_UUID}`, expect.any(String), 60);
    const cached = JSON.parse(store.data.get(`idempotency:u1:${IDEM_UUID}`) ?? "{}") as {
      status: number;
      body: unknown;
      fingerprint: string;
    };
    expect(cached.status).toBe(201);
    expect(cached.body).toEqual({ id: "created" });
    expect(cached.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("defaults the result TTL to 24 h and the status to 200", async () => {
    await testCase("NB-810", "default TTL and status");
    const { store, call } = setup();
    await call({ key: IDEM_UUID }).run();

    expect(store.set).toHaveBeenCalledWith(STORE_KEY, expect.any(String), 86_400);
    expect(JSON.parse(store.data.get(STORE_KEY) ?? "{}")).toMatchObject({ status: 200 });
  });

  it("replays the cached response for the same request without invoking the handler", async () => {
    await testCase("NB-811", "same key + same request → replay");
    const { call } = setup();
    Reflect.defineMetadata("__httpCode__", 201, handlerFn);
    await call({ key: IDEM_UUID }).run();

    const retry = call({ key: IDEM_UUID, result: { id: "second-run" } });
    await expect(retry.run()).resolves.toEqual({ id: "created" });

    expect(retry.handle).not.toHaveBeenCalled();
    expect(retry.header).toHaveBeenCalledWith("X-Idempotent-Replayed", "true");
    expect(retry.status).toHaveBeenCalledWith(201);
  });

  it("treats the key case-insensitively", async () => {
    await testCase("NB-812", "upper-case key replays the lower-case entry");
    const { call } = setup();
    await call({ key: IDEM_UUID }).run();

    const retry = call({ key: IDEM_UUID.toUpperCase() });
    await retry.run();

    expect(retry.handle).not.toHaveBeenCalled();
    expect(retry.header).toHaveBeenCalledWith("X-Idempotent-Replayed", "true");
  });

  it("replays a handler that returned nothing as a null body", async () => {
    await testCase("NB-813", "void result is cached as null");
    const { call } = setup();
    await call({ key: IDEM_UUID, result: undefined }).run();

    const retry = call({ key: IDEM_UUID });
    await expect(retry.run()).resolves.toBeNull();
    expect(retry.handle).not.toHaveBeenCalled();
  });

  it("answers 409 when the same key arrives with a different body", async () => {
    await testCase("NB-814", "same key + different body → 409");
    const { call } = setup();
    await call({ key: IDEM_UUID, body: { title: "a" } }).run();

    const other = call({ key: IDEM_UUID, body: { title: "b" } });
    await expect(other.run()).rejects.toThrow(ConflictException);
    await expect(call({ key: IDEM_UUID, body: { title: "b" } }).run()).rejects.toThrow(
      /already used for a different request/u,
    );
    expect(other.handle).not.toHaveBeenCalled();
    expect(other.header).not.toHaveBeenCalled();
  });

  it("answers 409 when the same key arrives for a different path", async () => {
    await testCase("NB-815", "same key + different path → 409");
    const { call } = setup();
    await call({ key: IDEM_UUID, url: "/tasks" }).run();

    await expect(call({ key: IDEM_UUID, url: "/other" }).run()).rejects.toThrow(ConflictException);
  });

  it("keeps different users apart under the same client key", async () => {
    await testCase("NB-816", "store key is scoped by user");
    const { store, call } = setup();
    const alice = call({ key: IDEM_UUID, userId: "alice" });
    const bob = call({ key: IDEM_UUID, userId: "bob", body: { title: "other" } });

    await alice.run();
    await bob.run();

    expect(store.get).toHaveBeenCalledWith(`idempotency:alice:${IDEM_UUID}`);
    expect(store.get).toHaveBeenCalledWith(`idempotency:bob:${IDEM_UUID}`);
    expect(alice.handle).toHaveBeenCalledOnce();
    expect(bob.handle).toHaveBeenCalledOnce();
  });

  it("answers 409 while an identical request is still in flight", async () => {
    await testCase("NB-817", "PROCESSING entry → 409");
    const { store, call } = setup();
    store.data.set(STORE_KEY, PROCESSING_SENTINEL);
    const req = call({ key: IDEM_UUID });

    await expect(req.run()).rejects.toThrow(ConflictException);
    expect(req.handle).not.toHaveBeenCalled();
    // The in-flight request owns the lock; a 409 must not release it.
    expect(store.del).not.toHaveBeenCalled();
  });

  it("answers 409 when it loses the SET NX race", async () => {
    await testCase("NB-818", "lost lock race → 409");
    const { store, call } = setup();
    vi.mocked(store.setNx).mockResolvedValueOnce(false);
    const req = call({ key: IDEM_UUID });

    await expect(req.run()).rejects.toThrow(ConflictException);
    expect(req.handle).not.toHaveBeenCalled();
    expect(store.del).not.toHaveBeenCalled();
  });

  it.each([
    ["an old-schema entry", JSON.stringify({ status: 201, body: { id: "x" } })],
    ["an out-of-range status", JSON.stringify({ status: 99, body: null, fingerprint: "f" })],
    ["invalid JSON", "{not-json"],
  ])("evicts %s and re-executes", async (_label, raw) => {
    await testCase("NB-819", "corrupted entry is evicted, request runs fresh");
    const { store, call } = setup();
    store.data.set(STORE_KEY, raw);
    const req = call({ key: IDEM_UUID });

    await expect(req.run()).resolves.toEqual({ id: "created" });
    expect(store.del).toHaveBeenCalledWith(STORE_KEY);
    expect(req.handle).toHaveBeenCalledOnce();
    expect(JSON.parse(store.data.get(STORE_KEY) ?? "{}")).toHaveProperty("fingerprint");
  });

  it("releases the lock and rethrows when the handler fails, so a retry can run", async () => {
    await testCase("NB-820", "handler error releases the lock");
    const { store, call } = setup();
    const boom = new Error("boom");

    await expect(call({ key: IDEM_UUID, result: boom }).run()).rejects.toBe(boom);
    expect(store.del).toHaveBeenCalledWith(STORE_KEY);
    expect(store.data.has(STORE_KEY)).toBe(false);

    const retry = call({ key: IDEM_UUID });
    await expect(retry.run()).resolves.toEqual({ id: "created" });
    expect(retry.handle).toHaveBeenCalledOnce();
  });

  it("still rethrows the handler error when releasing the lock fails", async () => {
    await testCase("NB-821", "lock release failure is logged, not masking the error");
    const { store, warn, call } = setup();
    vi.mocked(store.del).mockRejectedValueOnce(new Error("valkey down"));
    const boom = new Error("boom");

    await expect(call({ key: IDEM_UUID, result: boom }).run()).rejects.toBe(boom);
    expect(warn).toHaveBeenCalledWith(expect.anything(), "Failed to release idempotency lock");
  });

  it("fails open when the store read errors — a dead Valkey does not block the request", async () => {
    await testCase("NB-822", "store get error → run without idempotency");
    const { store, warn, call } = setup();
    vi.mocked(store.get).mockRejectedValueOnce(new Error("valkey down"));
    const req = call({ key: IDEM_UUID });

    await expect(req.run()).resolves.toEqual({ id: "created" });
    expect(req.handle).toHaveBeenCalledOnce();
    expect(store.setNx).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("fails open when the lock cannot be acquired because the store errors", async () => {
    await testCase("NB-823", "store setNx error → run without idempotency");
    const { store, call } = setup();
    vi.mocked(store.setNx).mockRejectedValueOnce(new Error("valkey down"));
    const req = call({ key: IDEM_UUID });

    await expect(req.run()).resolves.toEqual({ id: "created" });
    expect(req.handle).toHaveBeenCalledOnce();
    expect(store.set).not.toHaveBeenCalled();
  });

  it("returns the handler result even when caching it fails", async () => {
    await testCase("NB-824", "cache write error is logged, response still sent");
    const { store, warn, call } = setup();
    vi.mocked(store.set).mockRejectedValueOnce(new Error("valkey down"));
    const req = call({ key: IDEM_UUID });

    await expect(req.run()).resolves.toEqual({ id: "created" });
    expect(warn).toHaveBeenCalledWith(expect.anything(), "Failed to cache idempotency response");
  });
});
