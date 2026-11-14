import { describe, expect, it } from "vitest";

import {
  CIRCULAR,
  logRecordMasker,
  parseRedactKeys,
  REDACTED,
  redact,
  redactQuery,
  redactUrl,
  TRUNCATED,
} from "./redact.js";

describe("redactUrl", () => {
  it("masks the password of a URL with userinfo and leaves everything else alone", () => {
    expect(redactUrl("postgres://app:s3cret@h")).toBe("postgres://app:xxxxx@h");
    expect(redactUrl("postgresql://app:s3cret@localhost:5432/app?sslmode=require")).toBe(
      "postgresql://app:xxxxx@localhost:5432/app?sslmode=require",
    );
    expect(redactUrl("redis://:pw@valkey:6379/0")).toBe("redis://:xxxxx@valkey:6379/0");
    expect(redactUrl("redis://valkey:6379")).toBe("redis://valkey:6379");
    expect(redactUrl("amqp://user@host")).toBe("amqp://user@host");
    expect(redactUrl("not a url with @ and ://")).toBe("not a url with @ and ://");
    expect(redactUrl("plain")).toBe("plain");
  });

  it("masks a password that itself contains an @, and a URL inside a longer text", () => {
    expect(redactUrl("postgres://app:p@ss@db/app")).toBe("postgres://app:xxxxx@db/app");
    expect(redactUrl("error: dial postgres://app:pw@db: refused")).toBe(
      "error: dial postgres://app:xxxxx@db: refused",
    );
    expect(redactUrl("a://u:1@h and b://v:2@g")).toBe("a://u:xxxxx@h and b://v:xxxxx@g");
  });

  it("masks query parameters named like a secret, keeping the order of the rest", () => {
    expect(redactUrl("https://h/p?page=2&token=abc&x=1")).toBe(
      "https://h/p?page=2&token=[redacted]&x=1",
    );
    expect(redactUrl("https://h/p?access_token=abc#frag")).toBe(
      "https://h/p?access_token=[redacted]#frag",
    );
    expect(redactUrl("https://h/p?tokens_used=3&author=x")).toBe(
      "https://h/p?tokens_used=3&author=x",
    );
  });

  it("masks the password of a keyword DSN, quoted or not", () => {
    expect(redactUrl("host=db password=pw user=app")).toBe("host=db password=[redacted] user=app");
    expect(redactUrl("host=db password='p w\\'x' user=app")).toBe(
      "host=db password=[redacted] user=app",
    );
    expect(redactUrl("a=b; Pwd=secret; c=d")).toBe("a=b; Pwd=[redacted]; c=d");
    expect(redactUrl("retries=3 mypassword=1")).toBe("retries=3 mypassword=1");
  });
});

describe("redactQuery", () => {
  it("masks secret parameters of a bare query string", () => {
    expect(redactQuery("page=2&token=abc")).toBe("page=2&token=[redacted]");
    expect(redactQuery("token=abc&page=2")).toBe("token=[redacted]&page=2");
    expect(redactQuery("page=2")).toBe("page=2");
    expect(redactQuery("flag")).toBe("flag");
  });
});

describe("parseRedactKeys", () => {
  it("trims, lowercases and drops empty entries", () => {
    expect([...parseRedactKeys(" Email, ,IBAN,")]).toEqual(["email", "iban"]);
    expect(parseRedactKeys(undefined).size).toBe(0);
  });
});

describe("redact", () => {
  it("redacts values under secret-looking keys, keeping empty strings visible", () => {
    const out = redact({
      DATABASE_PASSWORD: "hunter2",
      passwd: "x",
      COOKIE_SECRET: "",
      ADMIN_TOKEN: "t",
      API_KEY: "k",
      api_key: "k",
      apikey: "k",
      PRIVATE_KEY: "-----BEGIN",
      credentials: { user: "u", pass: "p" },
      KAFKA_EXTRA_PROPERTIES: '{"sasl.password":"p"}',
      PORT: "3000",
    });
    expect(out).toEqual({
      DATABASE_PASSWORD: REDACTED,
      passwd: REDACTED,
      COOKIE_SECRET: "",
      ADMIN_TOKEN: REDACTED,
      API_KEY: REDACTED,
      api_key: REDACTED,
      apikey: REDACTED,
      PRIVATE_KEY: REDACTED,
      credentials: { user: REDACTED, pass: REDACTED },
      KAFKA_EXTRA_PROPERTIES: REDACTED,
      PORT: "3000",
    });
  });

  it("keeps a fingerprint that is already there instead of flattening it", () => {
    expect(redact({ ADMIN_TOKEN: "[redacted:0a1b2c3d]", note: "[redacted:0a1b2c3d]" })).toEqual({
      ADMIN_TOKEN: "[redacted:0a1b2c3d]",
      note: "[redacted:0a1b2c3d]",
    });
    expect(redact({ ADMIN_TOKEN: "[redacted:not-hex]" })).toEqual({ ADMIN_TOKEN: REDACTED });
  });

  it("rewrites URL passwords inside ordinary string values", () => {
    expect(redact({ DATABASE_URL: "postgres://app:s3cret@h" })).toEqual({
      DATABASE_URL: "postgres://app:xxxxx@h",
    });
  });

  it("walks arrays and nested objects, leaving numbers/booleans/null/dates as is", () => {
    const when = new Date("2026-01-01T00:00:00Z");
    expect(
      redact({
        n: 1,
        b: true,
        nothing: null,
        when,
        list: ["postgres://a:b@c", { token: "x" }, 2],
        TOKEN_TTL_SECONDS: 3600,
      }),
    ).toEqual({
      n: 1,
      b: true,
      nothing: null,
      when,
      list: ["postgres://a:xxxxx@c", { token: REDACTED }, 2],
      TOKEN_TTL_SECONDS: 3600,
    });
  });

  it("passes scalars through", () => {
    expect(redact("postgres://a:b@c")).toBe("postgres://a:xxxxx@c");
    expect(redact(undefined)).toBeUndefined();
    expect(redact(42)).toBe(42);
  });
});

/** `leaf` nested under `levels` objects: nest(2, x) is { next: { next: x } }. */
function nest(levels: number, leaf: unknown): unknown {
  let value = leaf;
  for (let i = 0; i < levels; i += 1) value = { next: value };
  return value;
}

describe("redact — what is not a plain value", () => {
  it("a URL object is masked like its text, and redacted whole under a secret key", () => {
    const url = new URL("postgres://app:s3cret@db/app");
    expect(redact({ target: url, dsn: url })).toEqual({
      target: "postgres://app:xxxxx@db/app",
      dsn: REDACTED,
    });
  });

  it("a value that serializes itself is left to — unless it sits under a secret key", () => {
    const bytes = Buffer.from("payload");
    const custom = { toJSON: () => "shown" };
    const out = redact({ bytes, custom, token: custom, password: bytes }) as Record<
      string,
      unknown
    >;
    expect(out["bytes"]).toBe(bytes); // the very object: its own toJSON prints it
    expect(out["custom"]).toBe(custom);
    expect(out["token"]).toBe(REDACTED); // toJSON is no promise of discretion
    expect(out["password"]).toBe(REDACTED);
  });

  it("only what redacts itself (a Secret: expose()) may stay under a secret key", () => {
    const secretLike = { expose: () => "s3cret", toJSON: () => "[redacted:0a1b2c3d]" };
    const out = redact({ token: secretLike }) as Record<string, unknown>;
    expect(out["token"]).toBe(secretLike);
    expect(JSON.stringify(out)).toBe('{"token":"[redacted:0a1b2c3d]"}');
  });

  it("an Error is left for its serializer, and redacted under a secret key", () => {
    const err = new Error("boom");
    const out = redact({ cause: err, auth_error: err }) as Record<string, unknown>;
    expect(out["cause"]).toBe(err);
    expect(out["auth_error"]).toBe(REDACTED);
  });

  it("a date stays a date, even under a secret key", () => {
    const when = new Date("2026-01-01T00:00:00Z");
    expect(redact({ token_issued: when })).toEqual({ token_issued: when });
  });
});

describe("redact — what cannot be walked is not shown", () => {
  it("an object that is its own ancestor becomes [Circular]: the original is never passed on", () => {
    const cyclic: Record<string, unknown> = { name: "a", password: "p-plaintext" };
    cyclic["self"] = cyclic;
    const out = redact(cyclic) as Record<string, unknown>;
    expect(out).toEqual({ name: "a", password: REDACTED, self: CIRCULAR });
    expect(JSON.stringify(out)).not.toContain("p-plaintext");

    // In an array, and through two objects.
    const a: Record<string, unknown> = { token: "p-plaintext" };
    const b = { back: [a] };
    a["forward"] = b;
    expect(redact(a)).toEqual({ token: REDACTED, forward: { back: [CIRCULAR] } });
  });

  it("the same object in two places is not a cycle: both are walked", () => {
    const shared = { password: "p-plaintext", n: 1 };
    expect(redact({ first: shared, second: shared, list: [shared, shared] })).toEqual({
      first: { password: REDACTED, n: 1 },
      second: { password: REDACTED, n: 1 },
      list: [
        { password: REDACTED, n: 1 },
        { password: REDACTED, n: 1 },
      ],
    });
  });

  it("eight levels are walked; an object below that becomes [Truncated], secret or not", () => {
    const leaf = { password: "p-plaintext", note: "plain" };
    // The leaf object is the 8th level: still walked.
    expect(redact(nest(7, leaf))).toEqual(nest(7, { password: REDACTED, note: "plain" }));
    // One deeper: replaced — never handed on with its password unmasked.
    expect(redact(nest(8, leaf))).toEqual(nest(8, TRUNCATED));
    expect(JSON.stringify(redact(nest(20, leaf)))).not.toContain("p-plaintext");
    // An array counts as a level too.
    expect(redact(nest(7, [leaf]))).toEqual(nest(7, [TRUNCATED]));
    // A string at any walked depth is still a leaf: masked, not truncated.
    expect(redact(nest(7, { url: "postgres://a:b@h" }))).toEqual(
      nest(7, { url: "postgres://a:xxxxx@h" }),
    );
  });
});

describe("logRecordMasker", () => {
  it("returns the record itself when nothing had to be masked — objects and arrays alike", () => {
    const mask = logRecordMasker();
    const inner = { id: 1, tags: ["a", "b"] };
    const record = { message: "ok", inner, list: [inner] };
    const out = mask(record);
    expect(out).toBe(record);
    expect(out["inner"]).toBe(inner);
  });

  it("copies only along the path that changed", () => {
    const mask = logRecordMasker();
    const untouched = { id: 1 };
    const record = { untouched, list: [untouched, { token: "t" }], db: { password: "p" } };
    const out = mask(record) as typeof record;
    expect(out).not.toBe(record);
    expect(out.untouched).toBe(untouched);
    expect(out.list).not.toBe(record.list);
    expect(out.list[0]).toBe(untouched);
    expect(out.list[1]).toEqual({ token: REDACTED });
    expect(record.db.password).toBe("p"); // the caller's object is never written to
  });

  it("extra keys are exact names, case-insensitive; the rule for secret-looking keys still holds", () => {
    const mask = logRecordMasker(new Set(["email"]));
    expect(mask({ Email: "a@b.c", EMAIL: "a@b.c", email_domain: "b.c", api_key: "k" })).toEqual({
      Email: REDACTED,
      EMAIL: REDACTED,
      email_domain: "b.c",
      api_key: REDACTED,
    });
    // Asked twice (the answer is cached): the same answer.
    expect(mask({ Email: "x", email_domain: "y" })).toEqual({ Email: REDACTED, email_domain: "y" });
  });

  it("a record is its own cycle and depth: nothing unmasked gets out", () => {
    const mask = logRecordMasker();
    const record: Record<string, unknown> = { password: "p-plaintext" };
    record["self"] = record;
    expect(mask(record)).toEqual({ password: REDACTED, self: CIRCULAR });
    // The path is cleared after each record: the next one is not "seen".
    expect(mask({ again: record })).toEqual({ again: { password: REDACTED, self: CIRCULAR } });
  });
});
