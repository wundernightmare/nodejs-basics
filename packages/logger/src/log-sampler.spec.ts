import { Writable } from "node:stream";

import pino from "pino";
import { describe, expect, it } from "vitest";

import { withDebugLogging } from "@base/common";
import { testCase } from "@base/testing";

import { LogLevel } from "./log-level.js";
import { LogSampler, messageOf, sampleSetting } from "./log-sampler.js";
import { buildPinoOptions } from "./pino.config.js";

describe("LogSampler", () => {
  it("passes the first `initial` per tick, then every `thereafter`-th", async () => {
    await testCase("NB-1143", "log sampling: first N per second per message, then every M-th");
    let now = 1_000;
    const sampler = new LogSampler({ initial: 3, thereafter: 4, now: () => now });
    const passed = (n: number): number[] =>
      Array.from({ length: n }, (_, i) => i + 1).filter(() => sampler.allow(30, "request"));
    expect(passed(12)).toEqual([1, 2, 3, 7, 11]);
    expect(sampler.dropped()).toEqual({ debug: 0, info: 7 });

    now += 1_000; // a new tick: the budget is back
    expect(passed(4)).toEqual([1, 2, 3]);
  });

  it("budgets each message and each level on its own", async () => {
    await testCase("NB-1143", "log sampling: first N per second per message, then every M-th");
    const sampler = new LogSampler({ initial: 1, thereafter: 1_000, now: () => 0 });
    expect([
      sampler.allow(30, "a"),
      sampler.allow(30, "a"),
      sampler.allow(30, "b"),
      sampler.allow(20, "a"),
      sampler.allow(20, "a"),
      sampler.allow(10, "t"),
      sampler.allow(10, "t"),
    ]).toEqual([true, false, true, true, false, true, false]);
    expect(sampler.dropped()).toEqual({ debug: 2, info: 1 });
  });

  it("never drops warn and above, and nothing at all when initial is 0", async () => {
    await testCase("NB-1144", "log sampling never drops warnings and errors");
    const sampler = new LogSampler({ initial: 1, thereafter: 1_000, now: () => 0 });
    for (const level of [40, 50, 60]) {
      expect([level, [1, 2, 3].every(() => sampler.allow(level, "boom"))]).toEqual([level, true]);
    }
    const off = new LogSampler({ initial: 0, now: () => 0 });
    expect([1, 2, 3].every(() => off.allow(30, "x"))).toBe(true);
    expect(off.dropped()).toEqual({ debug: 0, info: 0 });
  });

  it("reads the message of either pino call shape, and its settings from the environment", () => {
    expect([
      messageOf(["m"]),
      messageOf([{ a: 1 }, "m"]),
      messageOf([{ a: 1 }]),
      messageOf([]),
    ]).toEqual(["m", "m", "", ""]);
    expect(
      [undefined, "", " ", "0", "25", "-1", "1.5", "many"].map((raw) => sampleSetting(raw, 100)),
    ).toEqual([100, 100, 100, 0, 25, 100, 100, 100]);
  });

  it("is applied by the logger: repeats are dropped, a debugged request loses nothing", async () => {
    await testCase(
      "NB-1145",
      "the pino logger samples info/debug and bypasses it under debug logging",
    );
    const lines: Array<Record<string, unknown>> = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
        done();
      },
    });
    const sampler = new LogSampler({ initial: 2, thereafter: 1_000, now: () => 0 });
    const log = pino(buildPinoOptions(new LogLevel("debug"), sampler), sink);
    for (let i = 0; i < 5; i++) log.info({ i }, "tick");
    for (let i = 0; i < 5; i++) log.warn("careful");
    withDebugLogging(() => {
      for (let i = 0; i < 3; i++) log.info("tick");
    });
    const count = (message: string): number => lines.filter((l) => l["message"] === message).length;
    expect([count("tick"), count("careful")]).toEqual([2 + 3, 5]);
    expect(sampler.dropped()).toEqual({ debug: 0, info: 3 });
  });
});
