/**
 * IdempotencyInterceptor — what only a unit test can reach: races, a corrupt
 * store, a failing handler, a dead Valkey. Replay, 409 for another request
 * under the same key and the 400 for a bad key are the contract layer's
 * (apps/api app.contract.integration.spec.ts) against the real app.
 */
import { type CallHandler, ConflictException, type ExecutionContext } from "@nestjs/common";
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
      method: "POST",
      url: "/tasks",
      body: { title: "a" },
      headers: opts.key === undefined ? {} : { "idempotency-key": opts.key },
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

  it("caches for 24 h by default — and on a garbage IDEMPOTENCY_TTL_SECONDS", async () => {
    await testCase("NB-810", "default TTL");
    const envs: Record<string, string>[] = [{}, { IDEMPOTENCY_TTL_SECONDS: "a day" }];
    for (const env of envs) {
      const { store, call } = setup(env);
      // oxlint-disable-next-line no-await-in-loop -- one setup after another
      await call({ key: IDEM_UUID }).run();
      expect(store.set).toHaveBeenCalledWith(STORE_KEY, expect.any(String), 86_400);
    }
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
