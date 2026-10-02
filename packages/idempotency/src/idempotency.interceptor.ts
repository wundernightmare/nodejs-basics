/**
 * IdempotencyInterceptor
 *
 * Enforces at-most-once semantics for mutating HTTP requests.
 * Clients opt in by sending an `Idempotency-Key: <uuid>` header.
 *
 * Flow:
 *   1. Key absent → pass through (no-op). Key not a UUID → 400 problem.
 *   2. Key maps to a COMPLETED entry for the *same request* (method, path and
 *      body fingerprint) → replay the cached status + body, with
 *      `X-Idempotent-Replayed: true`. Same key, different request → 409
 *      problem: a key names one request, it must not hand a stranger — or a
 *      retry with a corrupted body — someone else's 201.
 *   3. Key maps to PROCESSING → 409 (another request is in flight).
 *   4. Key absent in store → atomically set to PROCESSING (NX), execute the
 *      handler, then store the result. Lock released on error so the client
 *      can retry.
 *
 * Storage key: `idempotency:{userId | "anon"}:{Idempotency-Key header}`
 *
 * Configuration:
 *   IDEMPOTENCY_TTL_SECONDS  Result TTL in seconds (default: 86400 — 24 h)
 */
import { createHash } from "node:crypto";

import {
  BadRequestException,
  type CallHandler,
  ConflictException,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { FastifyReply, FastifyRequest } from "fastify";
import { type Observable, from } from "rxjs";
import { firstValueFrom } from "rxjs";

import { AppLogger, ecsError } from "@base/logger";

import { IDEMPOTENCY_STORE, type IdempotencyStore } from "./idempotency.store.js";

const HTTP_CODE_METADATA = "__httpCode__";
/** The header is a UUID (RFC 9562 text form); anything else is a 400 problem, not a store key. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const PROCESSING_SENTINEL = "__processing__";
const LOCK_TTL_SECONDS = 30;

interface CachedEntry {
  status: number;
  body: unknown;
  /** sha256 of method + path + body of the request that produced the entry. */
  fingerprint: string;
}

function isCachedEntry(value: unknown): value is CachedEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["status"] === "number" &&
    Number.isInteger(v["status"]) &&
    v["status"] >= 100 &&
    v["status"] < 600 &&
    "body" in v &&
    typeof v["fingerprint"] === "string"
  );
}

/** What a key is bound to: the request line and the (parsed) body, canonicalised. */
function fingerprintOf(request: FastifyRequest): string {
  return createHash("sha256")
    .update(`${request.method} ${request.url}\n${JSON.stringify(request.body ?? null)}`)
    .digest("hex");
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger: ReturnType<AppLogger["child"]>;

  constructor(
    @Inject(IDEMPOTENCY_STORE) private readonly store: IdempotencyStore,
    private readonly config: ConfigService,
    appLogger: AppLogger,
  ) {
    this.logger = appLogger.child(IdempotencyInterceptor.name);
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: { userId: string } }>();
    const idempotencyKey = request.headers["idempotency-key"];

    if (
      idempotencyKey === undefined ||
      idempotencyKey === null ||
      typeof idempotencyKey !== "string"
    ) {
      return next.handle();
    }

    if (!UUID.test(idempotencyKey)) {
      throw new BadRequestException("Idempotency-Key must be a UUID");
    }

    const userId = request.user?.userId ?? "anon";
    const storeKey = `idempotency:${userId}:${idempotencyKey.toLowerCase()}`;

    return from(this.execute(context, next, storeKey, fingerprintOf(request)));
  }

  private async execute(
    context: ExecutionContext,
    next: CallHandler,
    storeKey: string,
    fingerprint: string,
  ): Promise<unknown> {
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    const configured = Number(this.config.get<string>("IDEMPOTENCY_TTL_SECONDS"));
    // A typo must not turn into a NaN TTL (the SET then fails and replay quietly stops).
    const ttl = Number.isInteger(configured) && configured > 0 ? configured : 86_400;
    const statusCode =
      (Reflect.getMetadata(HTTP_CODE_METADATA, context.getHandler()) as number | undefined) ?? 200;

    // Step 1: check existing entry
    let existing: string | null;
    try {
      existing = await this.store.get(storeKey);
    } catch (err) {
      this.logger.warn({ ...ecsError(err) }, "Idempotency store unavailable — skipping");
      return firstValueFrom(next.handle());
    }

    if (existing === PROCESSING_SENTINEL) {
      // Thrown, not sent: the exception layer answers it as problem+json like
      // every other error (see the contract, api/tsp/tasks.tsp).
      throw new ConflictException("A request with this Idempotency-Key is already being processed");
    }

    if (existing !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(existing);
      } catch {
        parsed = undefined;
      }
      if (isCachedEntry(parsed)) {
        if (parsed.fingerprint !== fingerprint) {
          throw new ConflictException(
            "Idempotency-Key was already used for a different request (same key, same request replays; a new request needs a new key)",
          );
        }
        // Hand the cached body back to NestJS instead of sending it here: the
        // router sends once (with the handler's @HttpCode, which is what was
        // cached), so Fastify never sees a second send.
        reply.header("X-Idempotent-Replayed", "true");
        void reply.status(parsed.status);
        return parsed.body ?? null;
      }
      // Corrupted / old-schema entry — evict and fall through to fresh execute.
      await this.store.del(storeKey).catch(() => {});
    }

    // Step 2: acquire processing lock (atomic SET NX)
    let acquired: boolean;
    try {
      acquired = await this.store.setNx(storeKey, PROCESSING_SENTINEL, LOCK_TTL_SECONDS);
    } catch (err) {
      this.logger.warn({ ...ecsError(err) }, "Failed to acquire idempotency lock — skipping");
      return firstValueFrom(next.handle());
    }

    if (!acquired) {
      // Thrown, not sent: the exception layer answers it as problem+json like
      // every other error (see the contract, api/tsp/tasks.tsp).
      throw new ConflictException("A request with this Idempotency-Key is already being processed");
    }

    // Step 3: execute handler, cache result, release lock on error
    let result: unknown;
    try {
      result = await firstValueFrom(next.handle());
    } catch (err) {
      await this.store.del(storeKey).catch((delErr: unknown) => {
        this.logger.warn({ ...ecsError(delErr) }, "Failed to release idempotency lock");
      });
      throw err;
    }

    try {
      await this.store.set(
        storeKey,
        JSON.stringify({ status: statusCode, body: result ?? null, fingerprint }),
        ttl,
      );
    } catch (err) {
      this.logger.warn({ ...ecsError(err) }, "Failed to cache idempotency response");
    }

    return result;
  }
}
