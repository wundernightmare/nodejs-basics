import { describe, expect, it } from "vitest";

import { parseRedactKeys, REDACTED, redact, redactQuery, redactUrl } from "./redact.js";

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
