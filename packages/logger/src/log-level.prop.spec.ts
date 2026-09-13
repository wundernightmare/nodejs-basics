import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { meta, propertyRuns, testCase } from "@base/testing";

import { formatDuration, parseDuration } from "./log-level.js";

// Property tests are the fuzz layer (README "Property-based testing"): 100
// generated cases per property under `pnpm test`, FC_NUM_RUNS=5000 under
// `pnpm fuzz`. Same rule as `propertyRuns()` in @base/testing, which this
// package does not depend on.
const numRuns = propertyRuns();

const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};
const DAY_MS = 86_400_000;

/** "12", "12.345" — the digits the duration grammar accepts. */
const decimal = fc.oneof(
  fc.nat({ max: 100_000 }).map(String),
  fc.tuple(fc.nat({ max: 1_000 }), fc.nat({ max: 999 })).map(([a, b]) => `${a}.${b}`),
);
const term = fc.tuple(decimal, fc.constantFrom("ms", "s", "m", "h", "d"));
const padding = fc.constantFrom("", " ", "  ", "\t", "\n");
/** What an operator may type: the grammar's alphabet in any order, plus arbitrary text. */
const anyInput = fc.oneof(
  fc.string(),
  fc.string({ unit: fc.constantFrom(..."0123456789.msdh ".split("")), maxLength: 320 }),
  fc.string({ unit: "binary", maxLength: 64 }),
  fc.array(term, { maxLength: 6 }).map((terms) => terms.map(([n, u]) => n + u).join("")),
);

describe("parseDuration / formatDuration (property)", () => {
  meta({
    epic: "nodejs-basics",
    feature: "logging",
    owner: "@team-platform",
    tags: ["logger", "unit", "property"],
  });

  it("formatDuration round-trips through parseDuration for every positive millisecond count", async () => {
    await testCase(
      "NB-721",
      "formatDuration round-trips through parseDuration for every positive mi",
    );
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 30 * DAY_MS }), (ms) => {
        const text = formatDuration(ms);
        expect(text).toMatch(/^(\d+h)?(\d+m)?(\d+s)?(\d+ms)?$/u);
        expect(text).not.toBe("");
        expect(parseDuration(text)).toBe(ms);
      }),
      { numRuns },
    );
  });

  it("parses every well-formed duration a generator emits: units in any order, decimals, surrounding whitespace", async () => {
    await testCase("NB-722", "parses every well-formed duration a generator emits");
    fc.assert(
      fc.property(
        fc.array(term, { minLength: 1, maxLength: 6 }),
        padding,
        padding,
        (terms, lead, trail) => {
          const text = lead + terms.map(([n, u]) => n + u).join("") + trail;
          let total = 0;
          for (const [n, u] of terms) total += Number(n) * UNIT_MS[u]!;
          // Below 1ms after rounding ("0.1ms") is not a duration.
          const expected = Math.round(total);
          if (expected > 0) expect(parseDuration(text)).toBe(expected);
          else expect(() => parseDuration(text)).toThrow(/^invalid duration/u);
        },
      ),
      { numRuns },
    );
  });

  it("a bare number is seconds; below 1ms it is rejected as non-positive", async () => {
    await testCase("NB-723", "a bare number is seconds; below 1ms it is rejected as non-positive");
    fc.assert(
      fc.property(decimal, padding, padding, (n, lead, trail) => {
        const expected = Math.round(Number(n) * 1_000);
        if (expected > 0) expect(parseDuration(lead + n + trail)).toBe(expected);
        else expect(() => parseDuration(lead + n + trail)).toThrow(/^duration must be positive/u);
      }),
      { numRuns },
    );
  });

  it("for any input: a finite positive integer, or exactly the documented error — never anything else", async () => {
    await testCase("NB-724", "for any input");
    const grammar = /^\s*(\d+(\.\d+)?|(\d+(\.\d+)?(ms|s|m|h|d))+)\s*$/u;
    fc.assert(
      fc.property(anyInput, (raw) => {
        let result: number;
        try {
          result = parseDuration(raw);
        } catch (err) {
          expect(err).toBeInstanceOf(Error);
          expect((err as Error).message).toMatch(
            /^(invalid duration |duration must be positive: )/u,
          );
          return;
        }
        expect(grammar.test(raw)).toBe(true);
        expect(Number.isInteger(result)).toBe(true);
        expect(result).toBeGreaterThan(0);
      }),
      {
        numRuns,
        // Found by this property: a number too long for a double parsed to
        // Infinity and was accepted as a "positive" duration; "0.0001" (or
        // "0.0001ms") rounded to 0 and was returned as one.
        examples: [["9".repeat(320)], [`${"9".repeat(320)}s`], ["0.0001"], ["0.0001ms"], ["1e3"]],
      },
    );
  });
});
