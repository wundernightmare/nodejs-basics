import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { meta, propertyRuns, testCase } from "@base/testing";

import { type BackoffSpec, computeJitteredDelay } from "./backoff.js";

// Property tests are the fuzz layer (README "Property-based testing"): 100
// generated cases per property under `pnpm test`, FC_NUM_RUNS=5000 under
// `pnpm fuzz`. Same rule as `propertyRuns()` in @base/testing, which this
// package does not depend on.
const numRuns = propertyRuns();

const finite = fc.double({ noNaN: true, noDefaultInfinity: true });
const nonFinite = fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY);
/** One rng draw, what Math.random returns: [0, 1). */
const draw = fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true });

/** Any finite policy, including the nonsensical ones (negative, zero, factor < 1). */
const anySpec: fc.Arbitrary<BackoffSpec> = fc.record({
  minTimeout: finite,
  maxTimeout: finite,
  factor: finite,
});
/** A policy a config could plausibly express. */
const saneSpec: fc.Arbitrary<BackoffSpec> = fc.record({
  minTimeout: fc.integer({ min: 0, max: 60_000 }),
  maxTimeout: fc.integer({ min: 0, max: 3_600_000 }),
  factor: fc.double({ min: 1, max: 10, noNaN: true }),
});

const cap = (spec: BackoffSpec, attempt: number): number =>
  Math.max(0, Math.min(spec.minTimeout * Math.pow(spec.factor, attempt), spec.maxTimeout));

describe("computeJitteredDelay (property)", () => {
  meta({
    epic: "nodejs-basics",
    feature: "resilient HTTP client",
    owner: "@team-platform",
    tags: ["resilient-client", "unit", "property"],
  });

  it("is an integer in [0, maxTimeout] for every policy, attempt and draw", async () => {
    await testCase("NB-701", "is an integer in [0");
    fc.assert(
      fc.property(anySpec, fc.integer(), draw, (spec, attempt, r) => {
        const d = computeJitteredDelay(spec, attempt, () => r);
        expect(Number.isInteger(d)).toBe(true);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(Math.max(0, spec.maxTimeout));
      }),
      {
        numRuns,
        // Found by this property: minTimeout 0 with factor^attempt overflowing
        // to Infinity gave 0 · Infinity = NaN, i.e. a NaN delay.
        examples: [[{ minTimeout: 0, maxTimeout: 5_000, factor: 2 }, 2_000, 0.5]],
      },
    );
  });

  it("attempt 0 draws from [0, minTimeout] whatever the factor", async () => {
    await testCase("NB-702", "attempt 0 draws from [0");
    fc.assert(
      fc.property(anySpec, draw, (spec, r) => {
        const d = computeJitteredDelay(spec, 0, () => r);
        expect(d).toBeLessThanOrEqual(Math.max(0, Math.min(spec.minTimeout, spec.maxTimeout)));
      }),
      { numRuns },
    );
  });

  it("the window never shrinks as attempts grow (factor ≥ 1) and saturates at maxTimeout", async () => {
    await testCase(
      "NB-703",
      "the window never shrinks as attempts grow (factor ≥ 1) and saturates a",
    );
    fc.assert(
      fc.property(saneSpec, fc.nat({ max: 200 }), fc.nat({ max: 200 }), draw, (spec, a, b, r) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const rng = () => r;
        expect(computeJitteredDelay(spec, lo, rng)).toBeLessThanOrEqual(
          computeJitteredDelay(spec, hi, rng),
        );
        // Once minTimeout · factor^attempt ≥ maxTimeout the cap is
        // maxTimeout, so the delay depends on the draw alone.
        if (spec.minTimeout * Math.pow(spec.factor, 5_000) >= spec.maxTimeout) {
          expect(computeJitteredDelay(spec, 5_000, rng)).toBe(Math.floor(r * spec.maxTimeout));
        }
      }),
      { numRuns },
    );
  });

  it("full jitter: the draw spans the whole [0, cap] window", async () => {
    await testCase("NB-704", "full jitter");
    fc.assert(
      fc.property(saneSpec, fc.nat({ max: 200 }), (spec, attempt) => {
        const c = cap(spec, attempt);
        expect(computeJitteredDelay(spec, attempt, () => 0)).toBe(0);
        const top = computeJitteredDelay(spec, attempt, () => 1 - Number.EPSILON);
        expect(top).toBeLessThanOrEqual(Math.floor(c));
        expect(top).toBeGreaterThanOrEqual(Math.floor(c) - 1);
      }),
      { numRuns },
    );
  });

  it("a negative attempt or a non-finite bound collapses to 0 rather than a NaN or endless sleep", async () => {
    await testCase(
      "NB-705",
      "a negative attempt or a non-finite bound collapses to 0 rather than a ",
    );
    const broken = fc.oneof(
      fc.record({ minTimeout: nonFinite, maxTimeout: finite, factor: finite }),
      fc.record({ minTimeout: finite, maxTimeout: nonFinite, factor: finite }),
    );
    fc.assert(
      fc.property(broken, fc.integer(), draw, (spec, attempt, r) => {
        expect(computeJitteredDelay(spec, attempt, () => r)).toBe(0);
      }),
      { numRuns },
    );
    fc.assert(
      fc.property(anySpec, fc.integer({ max: -1 }), draw, (spec, attempt, r) => {
        expect(computeJitteredDelay(spec, attempt, () => r)).toBe(0);
      }),
      { numRuns },
    );
  });
});
