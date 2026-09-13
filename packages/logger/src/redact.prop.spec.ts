import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { meta, propertyRuns, testCase } from "@base/testing";

import { REDACTED, isSecretKey, redact, redactUrl } from "./redact.js";

// Property tests are the fuzz layer (README "Property-based testing"): 100
// generated cases per property under `pnpm test`, FC_NUM_RUNS=5000 under
// `pnpm fuzz`. Same rule as `propertyRuns()` in @base/testing, which this
// package does not depend on.
const numRuns = propertyRuns();

const secretWord = fc.constantFrom(
  "password",
  "passwd",
  "secret",
  "token",
  "api_key",
  "api-key",
  "apikey",
  "private_key",
  "private-key",
  "credential",
);
/** A key the convention treats as a secret: the word alone, or buried in a longer key ("DATABASE_PASSWORD"). */
const secretKey = fc
  .tuple(fc.string({ maxLength: 8 }), secretWord, fc.string({ maxLength: 8 }))
  .map(([a, w, b]) => a + w + b)
  .filter(isSecretKey);
// fast-check biases keys towards "__proto__" / "constructor" / "toString".
// "constructor" is excluded only because toStrictEqual compares
// `a.constructor === b.constructor`, which an own key of that name hijacks.
const plainKey = fc
  .string({ minLength: 1, maxLength: 12 })
  .filter((k) => !isSecretKey(k) && k !== "constructor");
/** A value with an own "__proto__" key, as JSON.parse produces it. */
const ownProto = (json: string): unknown => JSON.parse(json);
/** A string redactUrl leaves alone: not URL-shaped (no scheme + userinfo). */
const plainString = fc.string().filter((s) => !(s.includes("://") && s.includes("@")));
const scalar = [
  fc.integer(),
  fc.double(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  plainString,
];

/** Characters legal in URL userinfo that the URL parser does not percent-encode. */
const userinfoChar = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~!$&'()*+,".split(""),
);
const dsn = fc
  .record({
    scheme: fc.constantFrom(
      "postgres",
      "postgresql",
      "redis",
      "rediss",
      "amqp",
      "kafka",
      "http",
      "https",
      "mongodb+srv",
    ),
    user: fc.string({ unit: userinfoChar, maxLength: 12 }),
    password: fc.string({ unit: userinfoChar, minLength: 1, maxLength: 16 }),
    host: fc.domain(),
    port: fc.option(fc.integer({ min: 1, max: 65_535 }), { nil: null }),
    path: fc.constantFrom("", "/", "/app", "/0", "/app?sslmode=require", "/x?y=1#frag"),
  })
  .map(({ scheme, user, password, host, port, path }) => ({
    url: `${scheme}://${user}:${password}@${host}${port === null ? "" : `:${port}`}${path}`,
    password,
  }));

function* stringLeaves(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const item of value) yield* stringLeaves(item);
  else if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    for (const item of Object.values(value)) yield* stringLeaves(item);
  }
}

describe("redact (property)", () => {
  meta({
    epic: "nodejs-basics",
    feature: "logging",
    owner: "@team-platform",
    tags: ["logger", "unit", "property"],
  });

  it("no string survives under a secret key, however deep, and nothing is dropped", async () => {
    await testCase("NB-711", "no string survives under a secret key");
    fc.assert(
      fc.property(
        plainKey,
        secretKey,
        fc.anything({ withDate: true, maxDepth: 3 }),
        (outer, key, tree) => {
          const out = redact({ [outer]: { [key]: tree } }) as Record<
            string,
            Record<string, unknown>
          >;
          const leaves = [...stringLeaves(out[outer]![key])];
          const before = [...stringLeaves(tree)];
          for (const leaf of leaves) expect(["", REDACTED]).toContain(leaf);
          expect(leaves.length).toBe(before.length);
          expect(leaves.filter((l) => l === "").length).toBe(before.filter((l) => l === "").length);
        },
      ),
      { numRuns },
    );
  });

  it("is idempotent: redacting a redacted value changes nothing", async () => {
    await testCase("NB-712", "is idempotent");
    fc.assert(
      fc.property(fc.anything({ key: plainKey, withDate: true, maxDepth: 3 }), (value) => {
        const once = redact(value);
        expect(redact(once)).toStrictEqual(once);
      }),
      { numRuns, examples: [[ownProto('{"__proto__": {"password": "x"}, "a": "b"}')]] },
    );
  });

  it("leaves a tree of non-secret keys and non-URL scalars exactly as it is", async () => {
    await testCase(
      "NB-713",
      "leaves a tree of non-secret keys and non-URL scalars exactly as it is",
    );
    fc.assert(
      fc.property(
        fc.anything({ key: plainKey, values: scalar, withDate: true, maxDepth: 3 }),
        (value) => {
          expect(redact(value)).toStrictEqual(value);
        },
      ),
      {
        numRuns,
        // Found by this property: `out[key] = …` turned an own "__proto__"
        // key into the prototype of the copy and dropped it.
        examples: [[ownProto('{"__proto__": {"a": "b"}, "c": 1}')]],
      },
    );
  });

  it("a URL password never survives — as a bare string, in an array, nested, or under a secret key", async () => {
    await testCase("NB-714", "a URL password never survives — as a bare string");
    fc.assert(
      fc.property(dsn, ({ url, password }) => {
        const masked = redactUrl(url);
        expect(new URL(masked).password).toBe("xxxxx");
        // The password text is gone — unless it also occurs elsewhere in the
        // URL, or is itself a run of "x" (the mask).
        if (url.split(password).length === 2 && !"xxxxx".includes(password)) {
          expect(masked).not.toContain(password);
        }
        const out = redact({ dsn: url, list: [url], nested: { url }, secret: url }) as {
          dsn: string;
          list: string[];
          nested: { url: string };
          secret: string;
        };
        expect(out.dsn).toBe(masked);
        expect(out.list[0]).toBe(masked);
        expect(out.nested.url).toBe(masked);
        expect(out.secret).toBe(REDACTED);
      }),
      { numRuns },
    );
  });

  it("redactUrl never throws: a URL with a password is masked, any other string comes back unchanged", async () => {
    await testCase("NB-715", "redactUrl never throws");
    const input = fc.oneof(
      fc.string(),
      fc.string({ unit: "binary" }),
      dsn.map((d) => d.url),
    );
    fc.assert(
      fc.property(input, (s) => {
        const out = redactUrl(s);
        let parsed: URL | null = null;
        try {
          parsed = new URL(s);
        } catch {
          parsed = null;
        }
        if (parsed !== null && parsed.password !== "") {
          expect(new URL(out).password).toBe("xxxxx");
        } else {
          expect(out).toBe(s);
        }
      }),
      { numRuns },
    );
  });
});
