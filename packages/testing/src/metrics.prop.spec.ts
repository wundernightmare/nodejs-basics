import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { meta, testCase } from "./meta.js";
import { metricValue } from "./metrics.js";
import { propertyRuns } from "./property.js";

const numRuns = propertyRuns();

const metricName = fc.stringMatching(/^[a-z][a-z0-9_]{0,24}$/u);
const labelName = fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,12}$/u);
/** Any text, with the characters the exposition format escapes or delimits over-represented. */
const labelValue = fc.string({
  unit: fc.oneof(
    { arbitrary: fc.string({ unit: "grapheme", minLength: 1, maxLength: 1 }), weight: 6 },
    { arbitrary: fc.constantFrom("\\", '"', "\n", "}", "{", ",", "=", " "), weight: 1 },
  ),
  maxLength: 12,
});
const sample = fc
  .double({ noNaN: true, noDefaultInfinity: true })
  .map((v) => (Object.is(v, -0) ? 0 : v));

interface Family {
  name: string;
  type: string;
  names: string[];
  rows: [string[], number][];
  timestamp: boolean;
  sibling: string;
}

/** One metric family: a fixed label set, distinct label tuples per row. */
const family: fc.Arbitrary<Family> = fc.uniqueArray(labelName, { maxLength: 3 }).chain((names) =>
  fc.record({
    name: metricName,
    type: fc.constantFrom("gauge", "counter", "histogram", "summary"),
    names: fc.constant(names),
    rows: fc.uniqueArray(
      fc.tuple(fc.array(labelValue, { minLength: names.length, maxLength: names.length }), sample),
      { minLength: 1, maxLength: 5, selector: ([values]) => JSON.stringify(values) },
    ),
    timestamp: fc.boolean(),
    sibling: fc.constantFrom("_total", "_bucket", "x", ""),
  }),
);

/** The exposition format's label-value escaping: backslash, quote, newline. */
const escape = (v: string): string =>
  v.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\n/gu, "\\n");

/** One family with a single `route` label — the shape of the parser's two findings. */
const route = (value: string): Family => ({
  name: "http",
  type: "gauge",
  names: ["route"],
  rows: [[[value], 1]],
  timestamp: false,
  sibling: "",
});

/** What a Prometheus exporter writes for the family (plus a same-prefix neighbour). */
function expose(f: Family): string {
  const line = (name: string, values: string[], v: number) => {
    const labels = f.names.map((n, i) => `${n}="${escape(values[i]!)}"`).join(",");
    const ts = f.timestamp ? " 1700000000000" : "";
    return `${name}${labels === "" ? "" : `{${labels}}`} ${String(v)}${ts}`;
  };
  const out = [`# HELP ${f.name} generated`, `# TYPE ${f.name} ${f.type}`];
  if (f.sibling !== "") {
    // A neighbour whose name starts with ours must not be mistaken for it.
    out.push(line(f.name + f.sibling, f.rows[0]![0], 123_456_789));
  }
  for (const [values, v] of f.rows) out.push(line(f.name, values, v));
  return `${out.join("\n")}\n`;
}
const labelsOf = (f: Family, values: string[]): Record<string, string> =>
  Object.fromEntries(f.names.map((n, i) => [n, values[i]!]));

describe("metricValue (property)", () => {
  meta({
    epic: "nodejs-basics",
    feature: "test harness",
    owner: "@team-platform",
    tags: ["testing", "unit", "property"],
  });

  it("reads back every sample a Prometheus exporter emits, by its full label set", async () => {
    await testCase("NB-741", "metricValue parses what an exporter writes");
    fc.assert(
      fc.property(family, (f) => {
        const text = expose(f);
        for (const [values, v] of f.rows) {
          expect(metricValue(text, f.name, labelsOf(f, values))).toBe(v);
        }
      }),
      {
        numRuns,
        // Found by this property: a "}" inside a label value, and the escaped
        // newline (\n), broke the label parser.
        examples: [[route("/t/{id}")], [route("a\nb")]],
      },
    );
  });

  it("a subset of the labels matches; a wrong value or an unknown name is -1", async () => {
    await testCase("NB-742", "metricValue: label subset, mismatch, absent series");
    fc.assert(
      fc.property(family, fc.nat(), (f, pick) => {
        const text = expose(f);
        const [values] = f.rows[pick % f.rows.length]!;
        // Matching on fewer labels finds *a* sample of the family, never -1.
        const partial = labelsOf(f, values);
        for (const n of f.names.slice(1)) delete partial[n];
        expect(f.rows.map(([, value]) => value)).toContain(metricValue(text, f.name, partial));
        expect(metricValue(text, f.name, {})).not.toBe(-1);
        // A value no row carries, or a name no line carries, is absent.
        if (f.names.length > 0) {
          const used = new Set(f.rows.map(([row]) => row[0]));
          const unused = [...Array(f.rows.length + 1).keys()]
            .map(String)
            .find((s) => !used.has(s))!;
          expect(metricValue(text, f.name, { [f.names[0]!]: unused })).toBe(-1);
        }
        expect(metricValue(text, `${f.name}_absent`, {})).toBe(-1);
        expect(metricValue(text, f.name, { no_such_label: "x" })).toBe(-1);
      }),
      { numRuns },
    );
  });

  it("never throws on arbitrary text, and a name on no line is -1", async () => {
    await testCase("NB-743", "metricValue is total");
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 200 }), metricName, (text, name) => {
        const got = metricValue(text, name, {});
        expect(typeof got).toBe("number");
        if (!text.includes(name)) expect(got).toBe(-1);
      }),
      { numRuns },
    );
  });
});
