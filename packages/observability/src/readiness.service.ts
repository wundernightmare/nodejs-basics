import { setTimeout as delay } from "node:timers/promises";

import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { metrics } from "@opentelemetry/api";

import { processEnv, readInt } from "@base/config";
import { AppLogger, redactUrl } from "@base/logger";

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
 *   1. beforeApplicationShutdown  → this service flips the gate: /readyz = 503 not_ready,
 *                                   then waits HTTP_SHUTDOWN_DELAY_MS while requests are
 *                                   still served — the time load balancers need to notice
 *   2. dispose()                  → Nest closes the API listener (in-flight requests drain)
 *   3. onApplicationShutdown      → AdminServerService closes the admin listener last
 * — the same order as golang-basics' httpx.Server.Run (SetReady(false) → API → admin),
 * so load balancers stop routing before the socket goes away and probes keep
 * answering while the API drains.
 *
 * Checks run at boot and every HEALTH_CHECK_INTERVAL_MS. /readyz returns the
 * latest snapshot without calling dependencies. Each result is exported as
 * health_check_up{check,critical} (1 passing, 0 failing).
 */
@Injectable()
export class ReadinessService
  implements BeforeApplicationShutdown, OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger: ReturnType<AppLogger["child"]>;
  private readonly registered: ReadinessCheck[] = [];
  private readonly intervalMs: number;
  private ready = true;
  private last: { name: string; up: boolean; optional: boolean }[] = [];
  private snapshot:
    | { checks: Record<string, string>; criticalFailing: boolean; optionalFailing: boolean }
    | undefined;
  private refreshing: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private dirty = true;
  private stopped = false;

  constructor(
    @Inject(READINESS_CHECKS) private readonly checks: ReadinessCheck[],
    appLogger: AppLogger,
  ) {
    this.logger = appLogger.child(ReadinessService.name);
    this.intervalMs = readInt(processEnv, "HEALTH_CHECK_INTERVAL_MS");
    metrics
      .getMeter("health")
      .createObservableGauge("health_check_up", {
        description:
          "Latest readiness check result: 1 passing, 0 failing; critical checks gate /readyz.",
      })
      .addCallback((result) => {
        for (const { name, up, optional } of this.last) {
          result.observe(up ? 1 : 0, { check: name, critical: String(!optional) });
        }
      });
  }

  /** Adds (or replaces, by name) a readiness check at runtime. */
  register(check: ReadinessCheck): void {
    const idx = this.registered.findIndex((c) => c.name === check.name);
    if (idx === -1) this.registered.push(check);
    else this.registered[idx] = check;
    this.dirty = true;
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.refresh();
    this.schedule();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.refreshing;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.refresh().finally(() => {
        this.schedule();
      });
    }, this.intervalMs);
    this.timer.unref();
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

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.ready = false;
    const delayMs = readInt(processEnv, "HTTP_SHUTDOWN_DELAY_MS");
    this.logger.info(
      { "process.signal": signal ?? null, "shutdown.delay_ms": delayMs },
      "Readiness gate closed — /readyz reports not_ready; draining after the shutdown delay",
    );
    if (delayMs > 0) await delay(delayMs);
  }

  /** Returns cached results; a newly registered check is evaluated before answering. */
  async check(): Promise<ReadinessResult> {
    if (this.dirty || this.snapshot === undefined) await this.refresh();
    const snapshot = this.snapshot;
    if (snapshot === undefined) return { status: "not_ready", ok: false, checks: {} };

    let status: ReadinessStatus = "ok";
    if (!this.ready || snapshot.criticalFailing) status = "not_ready";
    else if (snapshot.optionalFailing) status = "degraded";
    return { status, ok: status !== "not_ready", checks: { ...snapshot.checks } };
  }

  private refresh(): Promise<void> {
    if (this.refreshing !== undefined) return this.refreshing;
    this.refreshing = this.evaluate().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async evaluate(): Promise<void> {
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
          return { name: entry.name, value: redactUrl(message), optional: entry.optional === true };
        } finally {
          clearTimeout(timer);
        }
      }),
    );

    this.last = results.map(({ name, value, optional }) => ({
      name,
      up: value === "ok",
      optional,
    }));
    const checks: Record<string, string> = {};
    let criticalFailing = false;
    let optionalFailing = false;
    for (const { name, value, optional } of results) {
      checks[name] = value;
      if (value === "ok") continue;
      if (optional) optionalFailing = true;
      else criticalFailing = true;
    }
    this.snapshot = { checks, criticalFailing, optionalFailing };
    this.dirty = false;
  }
}
