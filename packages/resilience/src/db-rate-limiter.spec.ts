import { ServiceUnavailableException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";

import { meta, testCase } from "@base/testing";

import {
  buildDbRateLimiter,
  DbRateLimiter,
  type DbRateLimiterConfig,
  DEFAULT_DB_RATE_LIMITER,
} from "./db-rate-limiter.js";

// Minimal ConfigService double: ConfigService.get() reads process.env first,
// so an ambient DATABASE_RATE_LIMITER_* would leak into a real instance.
function stub(env: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

const cfg = (over: Partial<DbRateLimiterConfig> = {}): DbRateLimiterConfig => ({
  enabled: true,
  maxConcurrent: 2,
  minTimeMs: 0,
  ...over,
});

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("buildDbRateLimiter", () => {
  meta({
    epic: "nodejs-basics",
    feature: "resilience",
    owner: "@team-platform",
    tags: ["resilience", "unit"],
  });

  it("returns the defaults when nothing is set — disabled pass-through", async () => {
    await testCase("NB-744", "no env → limiter off");
    expect(buildDbRateLimiter(stub({}))).toEqual(DEFAULT_DB_RATE_LIMITER);
    expect(DEFAULT_DB_RATE_LIMITER.enabled).toBe(false);
  });

  it("honours every DATABASE_RATE_LIMITER_* knob", async () => {
    await testCase("NB-745", "env overrides all four knobs");
    const built = buildDbRateLimiter(
      stub({
        DATABASE_RATE_LIMITER_ENABLED: "true",
        DATABASE_RATE_LIMITER_MAX_CONCURRENT: "4",
        DATABASE_RATE_LIMITER_MIN_TIME_MS: "25",
        DATABASE_RATE_LIMITER_HIGHWATER: "100",
      }),
    );
    expect(built).toEqual({ enabled: true, maxConcurrent: 4, minTimeMs: 25, highWater: 100 });
  });

  it("falls back per knob on garbage and leaves highWater unset when not a number", async () => {
    await testCase("NB-746", "garbage values fall back to defaults");
    const built = buildDbRateLimiter(
      stub({
        DATABASE_RATE_LIMITER_ENABLED: "yes",
        DATABASE_RATE_LIMITER_MAX_CONCURRENT: "-1",
        DATABASE_RATE_LIMITER_MIN_TIME_MS: "soon",
        DATABASE_RATE_LIMITER_HIGHWATER: "lots",
      }),
    );
    expect(built).toEqual(DEFAULT_DB_RATE_LIMITER);
    expect(built).not.toHaveProperty("highWater");
  });
});

describe("DbRateLimiter", () => {
  meta({
    epic: "nodejs-basics",
    feature: "resilience",
    owner: "@team-platform",
    tags: ["resilience", "unit"],
  });

  it("acts as a pass-through when disabled — no allocations, no bookkeeping", async () => {
    await testCase("NB-747", "disabled limiter runs the action directly");
    const limiter = new DbRateLimiter(cfg({ enabled: false }));
    const result = await limiter.execute("k1", () => Promise.resolve(42));
    expect(result).toBe(42);
    expect(limiter.activeTenants()).toBe(0);
  });

  it("allocates one Bottleneck per key on first call, then reuses it", async () => {
    await testCase("NB-748", "one limiter per key");
    const limiter = new DbRateLimiter(cfg());
    await limiter.execute("k1", () => Promise.resolve(1));
    await limiter.execute("k1", () => Promise.resolve(2));
    await limiter.execute("k2", () => Promise.resolve(3));
    expect(limiter.activeTenants()).toBe(2);
    await limiter.shutdown();
  });

  it("caps concurrent in-flight calls per key at maxConcurrent", async () => {
    await testCase("NB-749", "per-key concurrency cap");
    const limiter = new DbRateLimiter(cfg({ maxConcurrent: 2 }));
    let inFlight = 0;
    let peak = 0;
    const work = async (): Promise<void> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick(5);
      inFlight -= 1;
    };
    await Promise.all(Array.from({ length: 5 }, () => limiter.execute("k1", work)));
    expect(peak).toBe(2);
    await limiter.shutdown();
  });

  it("does not cross-throttle different keys", async () => {
    await testCase("NB-750", "keys are isolated from each other");
    const limiter = new DbRateLimiter(cfg({ maxConcurrent: 1 }));
    let active = 0;
    let peak = 0;
    const work = async (): Promise<void> => {
      active += 1;
      peak = Math.max(peak, active);
      await tick(5);
      active -= 1;
    };
    await Promise.all([
      limiter.execute("k1", work),
      limiter.execute("k1", work),
      limiter.execute("k2", work),
      limiter.execute("k2", work),
    ]);
    expect(peak).toBe(2);
    await limiter.shutdown();
  });

  it("forget() releases a key's limiter so the map doesn't grow unbounded", async () => {
    await testCase("NB-751", "forget drops one limiter");
    const limiter = new DbRateLimiter(cfg());
    await limiter.execute("k1", () => Promise.resolve(1));
    expect(limiter.activeTenants()).toBe(1);
    await limiter.forget("k1");
    expect(limiter.activeTenants()).toBe(0);
    // Unknown key is a no-op.
    await expect(limiter.forget("never-seen")).resolves.toBeUndefined();
  });

  it("propagates the wrapped action's rejection unchanged", async () => {
    await testCase("NB-752", "action errors pass through");
    const limiter = new DbRateLimiter(cfg());
    const err = new Error("query failed");
    await expect(limiter.execute("k1", () => Promise.reject(err))).rejects.toBe(err);
    await limiter.shutdown();
  });

  it("rejects with ServiceUnavailable when highWater is set and the queue overflows", async () => {
    await testCase("NB-753", "overflow beyond highWater → 503");
    const limiter = new DbRateLimiter(cfg({ maxConcurrent: 1, highWater: 1 }));
    let release: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    // First job takes the only slot until released.
    const inFlight = limiter.execute("k1", async () => {
      await blocker;
    });
    // Let Bottleneck move the first job from the queue to running.
    await tick(5);
    // Second job sits in the (highWater=1) queue; the third overflows.
    const queued = limiter.execute("k1", () => Promise.resolve("ok"));
    const dropped = limiter.execute("k1", () => Promise.resolve("ok"));

    await expect(dropped).rejects.toBeInstanceOf(ServiceUnavailableException);
    release?.();
    await expect(Promise.all([inFlight, queued])).resolves.toEqual([undefined, "ok"]);
    await limiter.shutdown();
  });

  it("shutdown disconnects every limiter and clears the map", async () => {
    await testCase("NB-754", "shutdown releases all limiters");
    const limiter = new DbRateLimiter(cfg());
    await limiter.execute("k1", () => Promise.resolve(1));
    await limiter.execute("k2", () => Promise.resolve(2));
    expect(limiter.activeTenants()).toBe(2);
    await limiter.shutdown();
    expect(limiter.activeTenants()).toBe(0);
  });
});
