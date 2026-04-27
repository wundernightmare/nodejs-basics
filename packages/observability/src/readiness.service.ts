import { Inject, Injectable } from "@nestjs/common";

export interface ReadinessResult {
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
}

export const READINESS_CHECKS = Symbol("READINESS_CHECKS");

/**
 * Aggregates dependency health checks for GET /readyz.
 *
 * Provide checks in your AppModule:
 *
 *   {
 *     provide: READINESS_CHECKS,
 *     inject: [PG_POOL, VALKEY_CLIENT],
 *     useFactory: (pg: Pool, valkey: Valkey): ReadinessCheck[] => [
 *       { name: "db",     check: async () => { await pg.query("SELECT 1"); return "ok"; } },
 *       { name: "valkey", check: async () => { await valkey.ping();        return "ok"; } },
 *     ],
 *   }
 */
@Injectable()
export class ReadinessService {
  constructor(@Inject(READINESS_CHECKS) private readonly checks: ReadinessCheck[]) {}

  async check(): Promise<ReadinessResult> {
    const results = await Promise.all(
      this.checks.map(async (entry) => {
        const timeoutMs = entry.timeoutMs ?? 3_000;
        try {
          const result = await Promise.race([
            entry.check(),
            new Promise<never>((_, reject) =>
              setTimeout(() => {
                reject(new Error(`timeout after ${timeoutMs} ms`));
              }, timeoutMs),
            ),
          ]);
          return [entry.name, result] as const;
        } catch (err) {
          return [entry.name, (err as Error).message] as const;
        }
      }),
    );

    const checks: Record<string, string> = {};
    for (const [name, value] of results) checks[name] = value;
    const ok = results.every(([, value]) => value === "ok");
    return { ok, checks };
  }
}
