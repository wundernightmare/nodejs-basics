import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatDuration, LogLevel, parseDuration, parseLogLevelStrict } from "./log-level.js";

describe("parseLogLevelStrict", () => {
  it("accepts every pino level, case-insensitively, and the warning alias", () => {
    expect(parseLogLevelStrict("debug")).toBe("debug");
    expect(parseLogLevelStrict(" INFO ")).toBe("info");
    expect(parseLogLevelStrict("warning")).toBe("warn");
    expect(parseLogLevelStrict("silent")).toBe("silent");
  });

  it("rejects typos instead of falling back", () => {
    expect(() => parseLogLevelStrict("debgu")).toThrow(/unknown log level "debgu"/u);
    expect(() => parseLogLevelStrict("")).toThrow(/unknown log level/u);
    expect(() => parseLogLevelStrict(undefined)).toThrow(/unknown log level/u);
  });
});

describe("parseDuration / formatDuration", () => {
  it("parses Go-style durations into milliseconds", () => {
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("45s")).toBe(45_000);
    expect(parseDuration("1500ms")).toBe(1_500);
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("1.5s")).toBe(1_500);
    expect(parseDuration("90")).toBe(90_000); // bare number = seconds
  });

  it("rejects garbage and non-positive values", () => {
    for (const bad of ["", "abc", "10x", "5m3", "-5s", "0s", "0", "1h 30m"]) {
      expect(() => parseDuration(bad), bad).toThrow();
    }
  });

  it("formats round-trippably", () => {
    expect(formatDuration(24 * 3_600_000)).toBe("24h");
    expect(formatDuration(5_400_000)).toBe("1h30m");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(1_500)).toBe("1s500ms");
    expect(formatDuration(0)).toBe("0s");
  });
});

describe("LogLevel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts at the base level with no expiry", () => {
    const l = new LogLevel("info");
    expect(l.snapshot()).toEqual({ level: "info", base: "info", expires_at: null, max_ttl: "24h" });
    expect(l.enabled(30)).toBe(true);
    expect(l.enabled(20)).toBe(false);
  });

  it("reverts to the base level when the TTL expires", () => {
    const changes: string[] = [];
    const l = new LogLevel("info", {
      onChange: (level, prev, reason) => changes.push(`${prev}->${level}:${reason}`),
    });
    expect(l.set("debug", 30_000)).toBe("info");
    expect(l.level).toBe("debug");
    expect(l.expiresAt?.toISOString()).toBe("2026-01-01T00:00:30.000Z");
    expect(l.enabled(20)).toBe(true);

    vi.advanceTimersByTime(29_999);
    expect(l.level).toBe("debug");
    vi.advanceTimersByTime(1);
    expect(l.level).toBe("info");
    expect(l.expiresAt).toBeNull();
    expect(changes).toEqual(["info->debug:set", "debug->info:expired"]);
  });

  it("a stale timer never reverts a newer change (generation counter)", () => {
    const l = new LogLevel("info");
    l.set("debug", 10_000);
    vi.advanceTimersByTime(5_000);
    l.set("trace", 60_000); // newer change with a longer TTL
    vi.advanceTimersByTime(6_000); // the first timer would have fired by now
    expect(l.level).toBe("trace");
    vi.advanceTimersByTime(60_000);
    expect(l.level).toBe("info");
  });

  it("caps the TTL at maxTtl and defaults to it", () => {
    const l = new LogLevel("info", { maxTtlMs: 60_000 });
    l.set("debug", 3_600_000);
    expect(l.expiresAt?.toISOString()).toBe("2026-01-01T00:01:00.000Z");
    l.set("debug");
    expect(l.expiresAt?.toISOString()).toBe("2026-01-01T00:01:00.000Z");
    expect(l.snapshot().max_ttl).toBe("1m");
    vi.advanceTimersByTime(60_000);
    expect(l.level).toBe("info");
  });

  it("ttl <= 0 keeps the level until reset()", () => {
    const l = new LogLevel("info");
    l.set("warn", 0);
    expect(l.expiresAt).toBeNull();
    vi.advanceTimersByTime(48 * 3_600_000);
    expect(l.level).toBe("warn");
    expect(l.reset()).toBe("warn");
    expect(l.level).toBe("info");
  });

  it("reset() cancels a pending TTL", () => {
    const l = new LogLevel("info");
    l.set("debug", 10_000);
    l.reset();
    expect(l.snapshot()).toMatchObject({ level: "info", expires_at: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("silent disables everything", () => {
    const l = new LogLevel("info");
    l.set("silent", 0);
    expect(l.enabled(60)).toBe(false);
  });
});
