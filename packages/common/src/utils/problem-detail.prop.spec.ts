import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { meta, propertyRuns, testCase } from "@base/testing";

import { HTTP_STATUS_TITLES, problemDetail } from "./problem-detail.js";
import { withRequestId } from "./request-context.js";

// Property tests are the fuzz layer (README "Property-based testing"): 100
// generated cases per property under `pnpm test`, FC_NUM_RUNS=5000 under
// `pnpm fuzz`. Same rule as `propertyRuns()` in @base/testing, which this
// package does not depend on.
const numRuns = propertyRuns();

const STANDARD = new Set(["type", "title", "status", "detail"]);
/** Extension members, including attempts to smuggle in a standard member. */
const extensions = fc.dictionary(
  fc.oneof(
    fc.string({ minLength: 1, maxLength: 10 }),
    fc.constantFrom("type", "title", "status", "detail", "instance", "errorId", "request_id"),
  ),
  fc.jsonValue({ maxDepth: 2 }),
  { maxKeys: 6 },
);
const anyStatus = fc.oneof(fc.integer({ min: 100, max: 599 }), fc.integer());

describe("problemDetail (property)", () => {
  meta({
    epic: "nodejs-basics",
    feature: "problem details",
    owner: "@team-platform",
    tags: ["common", "unit", "property"],
  });

  it("type, title and status are always the standard members, whatever the status or the extensions", async () => {
    await testCase("NB-736", "type");
    fc.assert(
      fc.property(
        anyStatus,
        fc.option(fc.string(), { nil: undefined }),
        extensions,
        (status, detail, ext) => {
          const p = problemDetail(status, detail, ext);
          expect(p.type).toBe("about:blank");
          expect(p.status).toBe(status);
          expect(p.title).toBe(
            Object.hasOwn(HTTP_STATUS_TITLES, status) ? HTTP_STATUS_TITLES[status] : "Error",
          );
          if (detail !== undefined) expect(p.detail).toBe(detail);
          for (const [k, v] of Object.entries(ext)) {
            if (!STANDARD.has(k)) expect(p[k]).toStrictEqual(v);
          }
          // application/problem+json: serialisable, and the members survive the round trip.
          const wire = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
          expect(wire).toMatchObject({ type: "about:blank", title: p.title, status });
          if (detail !== undefined) expect(wire["detail"]).toBe(detail);
        },
      ),
      { numRuns },
    );
  });

  it("carries the request id of the ambient context, and only then", async () => {
    await testCase("NB-737", "carries the request id of the ambient context");
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.integer({ min: 100, max: 599 }), (id, status) => {
        expect(withRequestId(id, () => problemDetail(status)).request_id).toBe(id);
        expect(problemDetail(status)).not.toHaveProperty("request_id");
      }),
      { numRuns },
    );
  });
});
