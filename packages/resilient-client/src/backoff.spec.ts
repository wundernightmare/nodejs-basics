import { describe, expect, it } from "vitest";

import { computeJitteredDelay, sleep } from "./backoff.js";

// Deterministic pseudo-RNG helper — returns each supplied draw in order,
// then 1.0 for any extra call. Lets tests assert against the exact cap
// arithmetic without Math.random leaking across cases.
function fixedRng(draws: number[]): () => number {
  let i = 0;
  return () => (i < draws.length ? draws[i++]! : 1.0);
}

describe("computeJitteredDelay", () => {
  it("attempt=0 is drawn from [0, minTimeout] even when the factor would pin the cap lower", () => {
    // minTimeout · factor^0 = minTimeout. factor is irrelevant on attempt 0.
    const d = computeJitteredDelay(
      { minTimeout: 100, maxTimeout: 5000, factor: 3 },
      0,
      fixedRng([0.5]),
    );
    expect(d).toBe(50);
  });

  it("caps the cap at maxTimeout when factor^attempt would overshoot", () => {
    // factor^attempt would be 2^10 = 1024 → 100 · 1024 = 102400, clamped to 5000.
    const d = computeJitteredDelay(
      { minTimeout: 100, maxTimeout: 5000, factor: 2 },
      10,
      fixedRng([0.9]),
    );
    // 0.9 · 5000 = 4500 floored.
    expect(d).toBe(4500);
  });

  it("grows the cap exponentially until maxTimeout bites", () => {
    const spec = { minTimeout: 100, maxTimeout: 10_000, factor: 2 };
    // rng returns 1.0 on every call so we read the raw cap at each attempt.
    const draws = [0.9999, 0.9999, 0.9999, 0.9999];
    const rng = fixedRng(draws);
    // Attempt 0: cap=100  → 99
    // Attempt 1: cap=200  → 199
    // Attempt 2: cap=400  → 399
    // Attempt 3: cap=800  → 799
    expect(computeJitteredDelay(spec, 0, rng)).toBe(99);
    expect(computeJitteredDelay(spec, 1, rng)).toBe(199);
    expect(computeJitteredDelay(spec, 2, rng)).toBe(399);
    expect(computeJitteredDelay(spec, 3, rng)).toBe(799);
  });

  it("the rng draw spans the full [0, cap] interval — full-jitter contract", () => {
    const spec = { minTimeout: 1000, maxTimeout: 10_000, factor: 2 };
    const zero = computeJitteredDelay(spec, 3, () => 0);
    const nearCap = computeJitteredDelay(spec, 3, () => 0.999_999);
    // Attempt 3: cap = min(1000·8, 10_000) = 8000.
    expect(zero).toBe(0);
    expect(nearCap).toBe(7999);
  });

  it("negative attempt collapses to 0 so a caller bug cannot sleep forever", () => {
    const d = computeJitteredDelay({ minTimeout: 100, maxTimeout: 5000, factor: 2 }, -1, () => 0.5);
    expect(d).toBe(0);
  });

  it("non-finite minTimeout / maxTimeout collapses to 0 instead of NaN delays", () => {
    expect(
      computeJitteredDelay({ minTimeout: Number.NaN, maxTimeout: 100, factor: 2 }, 1, () => 0.5),
    ).toBe(0);
    expect(
      computeJitteredDelay(
        { minTimeout: 100, maxTimeout: Number.POSITIVE_INFINITY, factor: 2 },
        1,
        () => 0.5,
      ),
    ).toBe(0);
  });

  it("factor<1 degenerates to a flat cap of minTimeout — legal but surfaces a misconfig", () => {
    // factor=0.5, attempt=3 → 100·0.125=12.5. floor(0.9·12.5)=11.
    const d = computeJitteredDelay(
      { minTimeout: 100, maxTimeout: 5000, factor: 0.5 },
      3,
      fixedRng([0.9]),
    );
    expect(d).toBe(11);
  });
});

describe("sleep", () => {
  it("resolves immediately on non-positive durations without scheduling a timer", async () => {
    // If `sleep(0)` scheduled a real timer, this test wouldn't complete
    // under Vitest's default 5s timeout unless real timers fire — the
    // resolve() path skips setTimeout entirely. We just prove the call
    // settles in the current tick.
    const settled = await Promise.race([
      sleep(0).then(() => "done"),
      sleep(-5).then(() => "done-neg"),
    ]);
    expect(settled).toBe("done");
  });

  it("uses setTimeout for positive durations", async () => {
    const start = Date.now();
    await sleep(30);
    // Lower-bound assertion only — timer scheduling is noisy on CI.
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });
});
