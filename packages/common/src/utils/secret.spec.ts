import { createHash } from "node:crypto";
import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { testCase } from "@base/testing";

import { Secret } from "./secret.js";

const VALUE = "s3cr3t-token-value";
const FINGERPRINT = createHash("sha256").update(VALUE).digest("hex").slice(0, 8);

describe("Secret", () => {
  it("is reached through expose() only", async () => {
    await testCase("NB-1168", "Secret: expose() is the one way to the value");
    const secret = Secret.of(VALUE);
    expect(secret.expose()).toBe(VALUE);
    expect(secret.isSet).toBe(true);
    expect(Object.keys(secret)).toEqual([]);
    expect(Object.values(secret)).toEqual([]);
  });

  it("renders redacted with a fingerprint wherever a value is shown", async () => {
    await testCase("NB-1169", "Secret: every rendering is redacted");
    const secret = Secret.of(VALUE);
    const shown = `[redacted:${FINGERPRINT}]`;
    expect(secret.fingerprint()).toBe(FINGERPRINT);
    expect(String(secret)).toBe(shown);
    // What a careless log line does (the linter refuses it in product code).
    // oxlint-disable-next-line typescript/restrict-template-expressions
    expect(`token=${secret}`).toBe(`token=${shown}`);
    expect(JSON.stringify({ db: { password: secret } })).toBe(`{"db":{"password":"${shown}"}}`);
    expect(inspect(secret)).toBe(shown);
    expect(inspect({ nested: [secret] }, { depth: 0 })).not.toContain(VALUE);
    expect(
      inspect({ nested: { deeper: secret } }, { depth: null, showHidden: true }),
    ).not.toContain(VALUE);
    expect(new Error(`connect failed with ${String(secret)}`).message).not.toContain(VALUE);
  });

  it("keeps 'unset' visible", async () => {
    await testCase("NB-1170", "Secret: an unset secret renders empty and equals nothing");
    for (const unset of [Secret.of(""), Secret.of(undefined), Secret.of(null), Secret.unset]) {
      expect(unset.isSet).toBe(false);
      expect(unset.expose()).toBe("");
      expect(unset.fingerprint()).toBe("");
      expect(String(unset)).toBe("");
      expect(JSON.stringify({ token: unset })).toBe('{"token":""}');
      // No credential must not mean "any credential".
      expect(unset.equals("")).toBe(false);
      expect(unset.equals("anything")).toBe(false);
    }
  });

  it("compares by content, whatever the candidate's length", async () => {
    await testCase("NB-1171", "Secret: equals() compares content in constant time");
    const secret = Secret.of(VALUE);
    expect(secret.equals(VALUE)).toBe(true);
    expect(secret.equals(`${VALUE}x`)).toBe(false);
    expect(secret.equals(VALUE.slice(1))).toBe(false);
    expect(secret.equals("")).toBe(false);
    expect(secret.equals(undefined)).toBe(false);
  });

  it("wraps once", async () => {
    await testCase("NB-1168", "Secret: expose() is the one way to the value");
    const secret = Secret.of(VALUE);
    expect(Secret.of(secret)).toBe(secret);
    expect(Secret.of(" padded ").expose()).toBe(" padded ");
  });
});
