import type { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";

import { meta, testCase } from "@base/testing";

import {
  buildRetryPolicy,
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
  withRetry,
} from "./retry-policy.builder.js";

function stub(env: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

describe("buildRetryPolicy", () => {
  meta({
    epic: "nodejs-basics",
    feature: "resilience",
    owner: "@team-platform",
    tags: ["resilience", "unit"],
  });

  it("returns the defaults when nothing is set — dev path", async () => {
    await testCase("NB-767", "no env → default retry policy");
    expect(buildRetryPolicy(stub({}), "DATABASE")).toEqual(DEFAULT_RETRY_POLICY);
  });

  it("honours <PREFIX>_RETRY_* overrides for all four knobs", async () => {
    await testCase("NB-768", "<PREFIX>_RETRY_* overrides");
    const cfg = buildRetryPolicy(
      stub({
        DATABASE_RETRY_MAX_ATTEMPTS: "5",
        DATABASE_RETRY_BASE_DELAY_MS: "200",
        DATABASE_RETRY_MAX_DELAY_MS: "10000",
        DATABASE_RETRY_BUDGET_MS: "60000",
      }),
      "DATABASE",
    );
    expect(cfg).toEqual({ maxAttempts: 5, baseDelayMs: 200, maxDelayMs: 10_000, budgetMs: 60_000 });
  });

  it("ignores garbage values and falls back to the default per knob", async () => {
    await testCase("NB-769", "garbage values fall back per knob");
    const cfg = buildRetryPolicy(
      stub({
        VALKEY_RETRY_MAX_ATTEMPTS: "not-a-number",
        VALKEY_RETRY_BASE_DELAY_MS: "-50",
        VALKEY_RETRY_MAX_DELAY_MS: "",
        VALKEY_RETRY_BUDGET_MS: "45000",
      }),
      "VALKEY",
    );
    expect(cfg).toEqual({ ...DEFAULT_RETRY_POLICY, budgetMs: 45_000 });
  });

  it("scopes reads to the given prefix so one registry holds many dependencies", async () => {
    await testCase("NB-770", "prefix isolation");
    const cfg = buildRetryPolicy(
      stub({ DATABASE_RETRY_MAX_ATTEMPTS: "1", KAFKA_RETRY_MAX_ATTEMPTS: "9" }),
      "KAFKA",
    );
    expect(cfg.maxAttempts).toBe(9);
  });

  it("uses the per-call defaults argument instead of the library default", async () => {
    await testCase("NB-771", "caller-supplied defaults");
    const own: RetryPolicy = { maxAttempts: 7, baseDelayMs: 50, maxDelayMs: 500, budgetMs: 5000 };
    expect(buildRetryPolicy(stub({}), "VALKEY", own)).toEqual(own);
  });
});

describe("withRetry", () => {
  meta({
    epic: "nodejs-basics",
    feature: "resilience",
    owner: "@team-platform",
    tags: ["resilience", "unit"],
  });

  const fastPolicy: RetryPolicy = {
    maxAttempts: 5,
    baseDelayMs: 0,
    maxDelayMs: 0,
    budgetMs: 10_000,
  };

  it("returns the value on first success without touching the hooks", async () => {
    await testCase("NB-772", "first-try success");
    let calls = 0;
    const val = await withRetry(() => Promise.resolve("ok"), fastPolicy, {
      onAttempt: () => {
        calls += 1;
      },
    });
    expect(val).toBe("ok");
    expect(calls).toBe(0);
  });

  it("retries transient errors until success within maxAttempts", async () => {
    await testCase("NB-773", "transient failures are retried");
    let tries = 0;
    const attempts: number[] = [];
    const val = await withRetry(
      () => {
        tries += 1;
        if (tries < 3) return Promise.reject(new Error(`fail-${tries}`));
        return Promise.resolve("final");
      },
      fastPolicy,
      { onAttempt: ({ attempt }) => attempts.push(attempt) },
    );
    expect(val).toBe("final");
    expect(tries).toBe(3);
    expect(attempts).toEqual([0, 1]);
  });

  it("stops at once when isRetryable returns false — protects non-idempotent ops", async () => {
    await testCase("NB-774", "non-retryable error is rethrown immediately");
    let tries = 0;
    const seen: Array<{ attempt: number; delayMs: number }> = [];
    const err = new Error("permanent");
    await expect(
      withRetry(
        () => {
          tries += 1;
          return Promise.reject(err);
        },
        fastPolicy,
        {
          isRetryable: () => false,
          onAttempt: ({ attempt, delayMs }) => seen.push({ attempt, delayMs }),
        },
      ),
    ).rejects.toBe(err);
    expect(tries).toBe(1);
    // The terminal failure is reported with no delay.
    expect(seen).toEqual([{ attempt: 0, delayMs: 0 }]);
  });

  it("rethrows the last error after maxAttempts retries (1 initial + maxAttempts)", async () => {
    await testCase("NB-775", "attempts exhausted → last error");
    let tries = 0;
    let lastErr: unknown = null;
    await expect(
      withRetry(
        () => {
          tries += 1;
          return Promise.reject(new Error(`fail-${tries}`));
        },
        { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, budgetMs: 10_000 },
        {
          onAttempt: ({ error }) => {
            lastErr = error;
          },
        },
      ),
    ).rejects.toThrow("fail-3");
    expect(tries).toBe(3);
    expect((lastErr as Error).message).toBe("fail-3");
  });

  it("maxAttempts=0 fails fast with no retry", async () => {
    await testCase("NB-776", "zero attempts = fail fast");
    let tries = 0;
    await expect(
      withRetry(
        () => {
          tries += 1;
          return Promise.reject(new Error("once"));
        },
        { ...fastPolicy, maxAttempts: 0 },
      ),
    ).rejects.toThrow("once");
    expect(tries).toBe(1);
  });

  it("short-circuits once the wall-clock budget is spent even if attempts remain", async () => {
    await testCase("NB-777", "budget exhausted → no retry");
    // Every now() call advances 15 ms; a 10 ms budget is spent by the first failure.
    let ticks = 0;
    const now = (): number => {
      const t = ticks * 15;
      ticks += 1;
      return t;
    };
    let tries = 0;
    await expect(
      withRetry(
        () => {
          tries += 1;
          return Promise.reject(new Error("transient"));
        },
        { maxAttempts: 10, baseDelayMs: 0, maxDelayMs: 0, budgetMs: 10 },
        { now },
      ),
    ).rejects.toThrow("transient");
    expect(tries).toBe(1);
  });

  it("clamps the jittered delay to the remaining budget", async () => {
    await testCase("NB-778", "a jitter draw cannot overshoot the deadline");
    // start=0, first failure at 490 → 10 ms of budget left; rng≈1 would draw
    // ~baseDelayMs (100) on attempt 0, so the sleep must clamp to 10.
    const points = [0, 490, 600];
    let ticks = 0;
    const now = (): number => {
      const t = points[Math.min(ticks, points.length - 1)] ?? 0;
      ticks += 1;
      return t;
    };
    const delays: number[] = [];
    await expect(
      withRetry(
        () => Promise.reject(new Error("x")),
        { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 5000, budgetMs: 500 },
        { now, rng: () => 0.999_999, onAttempt: ({ delayMs }) => delays.push(delayMs) },
      ),
    ).rejects.toThrow("x");
    // First failure: clamped retry delay; second: budget spent → terminal (0).
    expect(delays).toEqual([10, 0]);
  });
});
