import { describe, expect, it } from "vitest";

import { REDACTED, redact, redactUrl } from "./redact.js";

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
