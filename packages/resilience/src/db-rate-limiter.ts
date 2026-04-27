/**
 * Per-tenant DB rate limiter.
 *
 * A single runaway tenant (a bad dashboard query, a malformed filter, a
 * bulk delete iterated per-row) can saturate the shared Postgres pool
 * and starve everyone else — the pool slots fill up, healthy tenants
 * queue on `acquire`, and tail latency spikes for the whole cluster.
 *
 * This rate limiter sits above the pool and gates query concurrency per
 * tenantId via a per-tenant Bottleneck. When a tenant reaches its cap
 * further calls queue inside the limiter — slots are released in FIFO
 * order as outstanding queries resolve. No pool slot is consumed while
 * a query is waiting on the limiter, so a noisy tenant cannot push its
 * quota onto the shared pool.
 *
 * Scope intentionally narrow:
 *   - Only tenantId-scoped calls go through. Global / non-tenant paths
 *     (auth, admin, infra) bypass entirely — there is no global limiter
 *     here because the pool's own `max` is the global cap.
 *   - The limiter is in-process. A multi-pod deployment therefore caps
 *     per-tenant concurrency at `maxConcurrent × replicas`. For the CP's
 *     tenant-to-pod fan-out this is fine; when we need cluster-wide caps
 *     we'll graduate to Bottleneck's Redis clustering (datastore:"ioredis").
 *
 * Env surface (consumed by buildDbRateLimiter):
 *   DATABASE_RATE_LIMITER_ENABLED        "false" by default
 *   DATABASE_RATE_LIMITER_MAX_CONCURRENT  queries in flight per tenantId (default 10)
 *   DATABASE_RATE_LIMITER_MIN_TIME_MS     min gap between jobs (default 0 — no spacing)
 *   DATABASE_RATE_LIMITER_HIGHWATER       when set, excess jobs are REJECTED
 *                                         instead of queued (strategy=OVERFLOW).
 *                                         Unset = unbounded queue.
 */
import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import Bottleneck from "bottleneck";

export interface DbRateLimiterConfig {
  /** Pass-through when false. */
  enabled: boolean;
  /** Max queries in flight per tenantId. */
  maxConcurrent: number;
  /** Min gap between jobs for the same tenantId (0 = no spacing). */
  minTimeMs: number;
  /**
   * When set, queued jobs beyond this count are rejected with 503 instead
   * of enqueued. `undefined` = unbounded queue (the default — rely on
   * concurrency cap + upstream HTTP timeouts to shed load).
   */
  highWater?: number;
}

export const DEFAULT_DB_RATE_LIMITER: DbRateLimiterConfig = {
  enabled: false,
  maxConcurrent: 10,
  minTimeMs: 0,
};

export function buildDbRateLimiter(config: ConfigService): DbRateLimiterConfig {
  const readStr = (key: string): string | undefined => {
    const v = config.get<string>(key);
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };
  const readNum = (key: string, fallback: number): number => {
    const raw = readStr(key);
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const readBool = (key: string, fallback: boolean): boolean => {
    const raw = readStr(key);
    if (raw === undefined) return fallback;
    return raw === "true" || raw === "1";
  };
  const highWaterRaw = readStr("DATABASE_RATE_LIMITER_HIGHWATER");
  const highWater =
    highWaterRaw !== undefined && Number.isFinite(Number(highWaterRaw))
      ? Number(highWaterRaw)
      : undefined;

  return {
    enabled: readBool("DATABASE_RATE_LIMITER_ENABLED", DEFAULT_DB_RATE_LIMITER.enabled),
    maxConcurrent: readNum(
      "DATABASE_RATE_LIMITER_MAX_CONCURRENT",
      DEFAULT_DB_RATE_LIMITER.maxConcurrent,
    ),
    minTimeMs: readNum("DATABASE_RATE_LIMITER_MIN_TIME_MS", DEFAULT_DB_RATE_LIMITER.minTimeMs),
    ...(highWater !== undefined ? { highWater } : {}),
  };
}

/**
 * Injectable per-tenant limiter. Callers wrap tenant-scoped DB work:
 *
 *   const rows = await dbRateLimiter.execute(tenantId, () =>
 *     prisma.application.findMany({ where: { tenantId } }),
 *   );
 *
 * Non-tenant work (auth, infra, cross-tenant jobs) calls the pool
 * directly and bypasses the limiter.
 */
@Injectable()
export class DbRateLimiter {
  readonly #enabled: boolean;
  readonly #cfg: DbRateLimiterConfig;
  readonly #tenants = new Map<string, Bottleneck>();

  constructor(cfg: DbRateLimiterConfig) {
    this.#cfg = cfg;
    this.#enabled = cfg.enabled;
  }

  /**
   * Run `action` under the tenant's limiter slot. When the limiter is
   * disabled, acts as a pure pass-through (no allocation, no bookkeeping).
   * Bottleneck's `schedule` returns whatever the wrapped function resolves
   * to; we keep the generic `T` throughout.
   *
   * When `highWater` is set and the limiter's queue is full, Bottleneck
   * resolves `schedule` with the job's `drop` outcome — caller gets a
   * typed ServiceUnavailable instead of a silent drop.
   */
  async execute<T>(tenantId: string, action: () => Promise<T>): Promise<T> {
    if (!this.#enabled) return action();
    const limiter = this.#getOrCreate(tenantId);
    try {
      return await limiter.schedule(action);
    } catch (err) {
      // Bottleneck rejects with `Bottleneck.BottleneckError` when a job
      // is dropped due to strategy=OVERFLOW + highWater hit. Surface as
      // a clean 503 so HTTP handlers produce the right status code.
      if (err instanceof Error && /dropped/i.test(err.message)) {
        throw new ServiceUnavailableException(
          `Database rate limit exceeded for tenant ${tenantId}`,
        );
      }
      throw err;
    }
  }

  /** Number of tenants with an active limiter. Diagnostic only. */
  activeTenants(): number {
    return this.#tenants.size;
  }

  /**
   * Release a tenant's limiter — useful on tenant deletion so the Map
   * doesn't grow unbounded in long-running pods. No-op if the tenant
   * has no limiter allocated.
   */
  async forget(tenantId: string): Promise<void> {
    const limiter = this.#tenants.get(tenantId);
    if (!limiter) return;
    this.#tenants.delete(tenantId);
    await limiter.disconnect();
  }

  /**
   * Drop every limiter — called on module destroy so bottleneck's internal
   * timers don't leak in tests.
   */
  async shutdown(): Promise<void> {
    const values = [...this.#tenants.values()];
    this.#tenants.clear();
    await Promise.all(values.map((l) => l.disconnect()));
  }

  #getOrCreate(tenantId: string): Bottleneck {
    const existing = this.#tenants.get(tenantId);
    if (existing) return existing;
    const limiter = new Bottleneck({
      maxConcurrent: this.#cfg.maxConcurrent,
      minTime: this.#cfg.minTimeMs,
      ...(this.#cfg.highWater !== undefined
        ? { highWater: this.#cfg.highWater, strategy: Bottleneck.strategy.OVERFLOW }
        : {}),
      // Per-tenant id shows up in Bottleneck's internal events; useful
      // when attaching OTel later (kept lightweight for now).
      id: `db-tenant-${tenantId}`,
    });
    this.#tenants.set(tenantId, limiter);
    return limiter;
  }
}
