import { ROOT_CONTEXT } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";

import { isTraceForced, Secret } from "@base/logger";
import { testCase } from "@base/testing";

import { DebugTokenPropagator } from "./debug-token-propagator.js";

describe("DebugTokenPropagator", () => {
  it("marks the context of a request that carries the debug token, and no other", async () => {
    await testCase(
      "NB-1363",
      "X-Debug-Token makes the request a debug trace before its span starts",
    );
    const propagator = new DebugTokenPropagator(Secret.of("s3cret"));
    const forced = (headers: Record<string, unknown>): boolean =>
      isTraceForced(propagator.extract(ROOT_CONTEXT, headers));
    expect(forced({ "x-debug-token": "s3cret" })).toBe(true);
    // node:http gives a repeated header as a list: the first one counts.
    expect(forced({ "x-debug-token": ["s3cret", "other"] })).toBe(true);
    expect(forced({ "x-debug-token": ["other", "s3cret"] })).toBe(false);
    expect(forced({ "x-debug-token": "s3cret " })).toBe(false);
    expect(forced({ "x-debug-token": "" })).toBe(false);
    expect(forced({ "x-debug-token": 42 })).toBe(false);
    expect(forced({})).toBe(false);
  });

  it("does nothing without a token configured, and sends nothing downstream", () => {
    for (const unset of [undefined, "", Secret.unset]) {
      const propagator = new DebugTokenPropagator(unset);
      expect(isTraceForced(propagator.extract(ROOT_CONTEXT, { "x-debug-token": "" }))).toBe(false);
      expect(isTraceForced(propagator.extract(ROOT_CONTEXT, { "x-debug-token": "x" }))).toBe(false);
    }
    const propagator = new DebugTokenPropagator("s3cret");
    const carrier: Record<string, string> = {};
    propagator.inject();
    expect(carrier).toEqual({});
    expect(propagator.fields()).toEqual([]);
    // A carrier of another shape goes through the getter it comes with.
    const map = new Map([["x-debug-token", "s3cret"]]);
    const getter = {
      get: (c: Map<string, string>, key: string) => c.get(key),
      keys: (c: Map<string, string>) => [...c.keys()],
    };
    expect(isTraceForced(propagator.extract(ROOT_CONTEXT, map, getter))).toBe(true);
  });
});
