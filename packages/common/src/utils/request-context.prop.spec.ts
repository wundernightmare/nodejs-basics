import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { meta, propertyRuns, testCase } from "@base/testing";

import { isValidRequestId } from "./request-context.js";

// Property tests are the fuzz layer (README "Property-based testing"): 100
// generated cases per property under `pnpm test`, FC_NUM_RUNS=5000 under
// `pnpm fuzz`. Same rule as `propertyRuns()` in @base/testing, which this
// package does not depend on.
const numRuns = propertyRuns();

/** Printable, non-space ASCII: 0x21 '!' … 0x7e '~'. */
const printable = fc.constantFrom(
  ...Array.from({ length: 94 }, (_, i) => String.fromCharCode(0x21 + i)),
);
const validId = fc.string({ unit: printable, minLength: 1, maxLength: 128 });
/** Space, controls, DEL, NUL, NBSP, non-ASCII, an astral character. */
const intruder = fc.constantFrom(
  " ",
  "\t",
  "\n",
  "\r",
  String.fromCharCode(0x7f),
  String.fromCharCode(0x00),
  String.fromCharCode(0xa0),
  "é",
  "→",
  String.fromCodePoint(0x1f600),
);
const anyString = fc.oneof(
  fc.string(),
  fc.string({ unit: "binary" }),
  fc.string({ unit: "grapheme" }),
  validId,
  fc.string({ unit: "binary-ascii", minLength: 100, maxLength: 300 }),
);

describe("isValidRequestId (property)", () => {
  meta({
    epic: "nodejs-basics",
    feature: "request context",
    owner: "@team-platform",
    tags: ["common", "unit", "property"],
  });

  it("accepts exactly the strings of 1..128 printable non-space ASCII characters", async () => {
    await testCase(
      "NB-731",
      "accepts exactly the strings of 1..128 printable non-space ASCII charac",
    );
    fc.assert(
      fc.property(anyString, (s) => {
        expect(isValidRequestId(s)).toBe(/^[!-~]{1,128}$/u.test(s));
      }),
      { numRuns },
    );
  });

  it("every generated id is accepted; one space, control or non-ASCII character anywhere rejects it, as does a 129th character", async () => {
    await testCase("NB-732", "every generated id is accepted; one space");
    fc.assert(
      fc.property(validId, intruder, fc.nat(), (id, bad, pos) => {
        expect(isValidRequestId(id)).toBe(true);
        const at = pos % (id.length + 1);
        expect(isValidRequestId(id.slice(0, at) + bad + id.slice(at))).toBe(false);
        expect(isValidRequestId(id.padEnd(129, "x"))).toBe(false);
      }),
      { numRuns },
    );
  });

  it("rejects every non-string", async () => {
    await testCase("NB-733", "rejects every non-string");
    fc.assert(
      fc.property(
        fc.anything({ withDate: true, withBigInt: true }).filter((v) => typeof v !== "string"),
        (v) => {
          expect(isValidRequestId(v)).toBe(false);
        },
      ),
      { numRuns },
    );
  });
});
