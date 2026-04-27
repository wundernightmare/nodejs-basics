/**
 * IdempotencyInterceptor
 *
 * Enforces at-most-once semantics for mutating HTTP requests.
 * Clients opt in by sending an `Idempotency-Key: <uuid>` header.
 *
 * Flow:
 *   1. Key absent → pass through (no-op).
 *   2. Key maps to a COMPLETED entry → replay the cached status + body,
 *      with `X-Idempotent-Replayed: true` response header.
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
import {
  type CallHandler,
  type ExecutionContext,
  HttpStatus,
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
const PROCESSING_SENTINEL = "__processing__";
const LOCK_TTL_SECONDS = 30;

interface CachedEntry {
  status: number;
  body: unknown;
}

function isCachedEntry(value: unknown): value is CachedEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["status"] === "number" &&
    Number.isInteger(v["status"]) &&
    v["status"] >= 100 &&
    v["status"] < 600 &&
    "body" in v
  );
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

    const userId = request.user?.userId ?? "anon";
    const storeKey = `idempotency:${userId}:${idempotencyKey}`;

    return from(this.execute(context, next, storeKey));
  }

  private async execute(
    context: ExecutionContext,
    next: CallHandler,
    storeKey: string,
  ): Promise<unknown> {
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    const ttl = parseInt(this.config.get<string>("IDEMPOTENCY_TTL_SECONDS") ?? "86400", 10);
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
      void reply.status(HttpStatus.CONFLICT).send({
        statusCode: HttpStatus.CONFLICT,
        error: "Conflict",
        message: "A request with this Idempotency-Key is already being processed",
      });
      return undefined;
    }

    if (existing !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(existing);
      } catch {
        parsed = undefined;
      }
      if (isCachedEntry(parsed)) {
        reply.header("X-Idempotent-Replayed", "true");
        void reply.status(parsed.status).send(parsed.body ?? null);
        return undefined;
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
      void reply.status(HttpStatus.CONFLICT).send({
        statusCode: HttpStatus.CONFLICT,
        error: "Conflict",
        message: "A request with this Idempotency-Key is already being processed",
      });
      return undefined;
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
        JSON.stringify({ status: statusCode, body: result ?? null }),
        ttl,
      );
    } catch (err) {
      this.logger.warn({ ...ecsError(err) }, "Failed to cache idempotency response");
    }

    return result;
  }
}
