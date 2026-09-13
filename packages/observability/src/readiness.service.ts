import { type BeforeApplicationShutdown, Inject, Injectable } from "@nestjs/common";

import { AppLogger } from "@base/logger";

/**
 * What GET /readyz reports:
 *   "ok"         200 — gate open, every check passing
 *   "degraded"   200 — gate open, only optional checks failing
 *   "not_ready"  503 — gate closed (shutting down), or a critical check failing
 */
export type ReadinessStatus = "ok" | "degraded" | "not_ready";

export interface ReadinessResult {
  status: ReadinessStatus;
  /** true unless status is "not_ready" (kept for callers that only need the bit). */
  ok: boolean;
  checks: Record<string, string>;
}

/**
 * A single named dependency check. Return "ok" on success or an error string
 * on failure. Throw to be auto-converted to a failure.
 */
export type ReadinessCheckFn = () => Promise<string>;

export interface ReadinessCheck {
  name: string;
  check: ReadinessCheckFn;
  /** Per-check timeout in ms. Default: 3000. */
  timeoutMs?: number;
  /**
   * Non-critical: when it fails the service reports "degraded" but stays
   * ready (200) because it can still do useful work without that dependency —
   * a cache it can bypass, an event bus it publishes to best-effort. Only
   * critical checks (the default) turn readiness to 503. This is the
   * difference between "one dependency flapped" and "every replica was pulled
   * out of the load balancer at once".
   */
  optional?: boolean;
}

export const READINESS_CHECKS = Symbol("READINESS_CHECKS");

/**
 * Aggregates dependency health checks for GET /readyz, plus a readiness gate
 * that shutdown closes first.
 *
 * Provide checks in your AppModule:
 *
 *   {
 *     provide: READINESS_CHECKS,
 *     inject: [PG_POOL, VALKEY_CLIENT],
 *     useFactory: (pg: Pool, valkey: Valkey): ReadinessCheck[] => [
 *       { name: "db",     check: async () => { await pg.query("SELECT 1"); return "ok"; } },
 *       { name: "valkey", check: async () => { await valkey.ping();        return "ok"; }, optional: true },
 *     ],
 *   }
 *
 * or register one from the service that owns the dependency (ObservabilityModule
 * is global, so ReadinessService is injectable anywhere):
 *
 *   constructor(readiness: ReadinessService) {
 *     readiness.register({ name: "kafka", check: async () => this.status() });
 *   }
 *
 * Shutdown order (Nest calls hooks in this sequence on app.close()/SIGTERM):
 *   1. beforeApplicationShutdown  → this service flips the gate: /readyz = 503 not_ready
 *   2. dispose()                  → Nest closes the API listener (in-flight requests drain)
 *   3. onApplicationShutdown      → AdminServerService closes the admin listener last
 * — the same order as golang-basics' httpx.Server.Run (SetReady(false) → API → admin),
 * so load balancers stop routing before the socket goes away and probes keep
 * answering while the API drains.
 */
@Injectable()
export class ReadinessService implements BeforeApplicationShutdown {
  private readonly logger: ReturnType<AppLogger["child"]>;
  private readonly registered: ReadinessCheck[] = [];
  private ready = true;

  constructor(
    @Inject(READINESS_CHECKS) private readonly checks: ReadinessCheck[],
    appLogger: AppLogger,
  ) {
    this.logger = appLogger.child(ReadinessService.name);
  }

  /** Adds (or replaces, by name) a readiness check at runtime. */
  register(check: ReadinessCheck): void {
    const idx = this.registered.findIndex((c) => c.name === check.name);
    if (idx === -1) this.registered.push(check);
    else this.registered[idx] = check;
  }

  /**
   * Flips the readiness gate. Open by default (the admin server starts during
   * bootstrap, a few ms before the API listens); closed by
   * beforeApplicationShutdown. Call setReady(false) at boot and setReady(true)
   * after app.listen() for the strict "never ready before listening" variant.
   */
  setReady(ready: boolean): void {
    this.ready = ready;
  }

  get isReady(): boolean {
    return this.ready;
  }

  beforeApplicationShutdown(signal?: string): void {
    this.ready = false;
    this.logger.info(
      { "process.signal": signal ?? null },
      "Readiness gate closed — /readyz reports not_ready while the API drains",
    );
  }

  async check(): Promise<ReadinessResult> {
    const all = [...this.checks, ...this.registered];
    const results = await Promise.all(
      all.map(async (entry) => {
        const timeoutMs = entry.timeoutMs ?? 3_000;
        let timer: NodeJS.Timeout | undefined;
        try {
          const result = await Promise.race([
            entry.check(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                reject(new Error(`timeout after ${timeoutMs} ms`));
              }, timeoutMs);
            }),
          ]);
          return { name: entry.name, value: result, optional: entry.optional === true };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { name: entry.name, value: message, optional: entry.optional === true };
        } finally {
          clearTimeout(timer);
        }
      }),
    );

    const checks: Record<string, string> = {};
    let criticalFailing = false;
    let optionalFailing = false;
    for (const { name, value, optional } of results) {
      checks[name] = value;
      if (value === "ok") continue;
      if (optional) optionalFailing = true;
      else criticalFailing = true;
    }

    let status: ReadinessStatus = "ok";
    if (!this.ready || criticalFailing) status = "not_ready";
    else if (optionalFailing) status = "degraded";
    return { status, ok: status !== "not_ready", checks };
  }
}
