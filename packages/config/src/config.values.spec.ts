import { describe, expect, it } from "vitest";

import { meta, testCase } from "@base/testing";

import {
  parseConfigValue,
  readBool,
  readInt,
  readJson,
  readNumber,
  readString,
} from "./config.values.js";

describe("typed config values", () => {
  meta({
    epic: "nodejs-basics",
    feature: "config",
    owner: "@team-platform",
    tags: ["config", "unit"],
  });

  it.each([
    ["int", " 42 ", 42],
    ["int", "-3", -3],
    ["number", "0.85", 0.85],
    ["bool", "TRUE", true],
    ["bool", "0", false],
    ["duration", "1h30m", "1h30m"],
    ["duration", "90", "90"],
    ["json", '{"a":1}', { a: 1 }],
    ["enum", "LZ4", "LZ4"],
  ] as const)("parses a %s %j", async (type, raw, value) => {
    await testCase("NB-964", "each registry type accepts its values");
    expect(parseConfigValue({ key: "K", type, values: ["lz4"] }, raw)).toEqual(value);
  });

  it.each([
    ["int", "1.5", "an integer"],
    ["int", "", "an integer"],
    ["int", "9007199254740993", "an integer"],
    ["number", "NaN", "a number"],
    ["bool", "yes", "true or false"],
    ["duration", "2 hours", "a duration (e.g. 30m, 2h, 45s, 1500ms)"],
    ["json", "[1]", "a JSON object"],
    ["json", "{", "a JSON object"],
    ["enum", "brotli", "one of lz4"],
  ] as const)("rejects a %s %j", async (type, raw, expected) => {
    await testCase("NB-965", "a value that does not parse names the key and what it wants");
    expect(() => parseConfigValue({ key: "K", type, values: ["lz4"] }, raw)).toThrow(
      `K=${JSON.stringify(raw)}: expected ${expected}`,
    );
  });

  it("checks bounds, inclusive", async () => {
    await testCase("NB-966", "min / max");
    const rule = { key: "K", type: "int", min: 1, max: 10 } as const;
    expect(parseConfigValue(rule, "1")).toBe(1);
    expect(parseConfigValue(rule, "10")).toBe(10);
    expect(() => parseConfigValue(rule, "11")).toThrow('K="11": expected an integer in [1, 10]');
    expect(() => parseConfigValue({ key: "K", type: "number", max: 1 }, "2")).toThrow(
      "expected a number <= 1",
    );
  });

  it("readers: unset is undefined (the caller's default), bounds come from the registry", async () => {
    await testCase("NB-967", "builders read typed values with the boot-time rules");
    const env: Record<string, string> = {
      OUTBOX_BATCH_SIZE: "0",
      HEAP_OOM_THRESHOLD: "0.9",
      DATABASE_KEEPALIVE: "false",
      KAFKA_EXTRA_PROPERTIES: '{"debug":"all"}',
      KAFKA_BROKERS: "",
    };
    const config = { get: (key: string) => env[key] };
    expect(() => readInt(config, "OUTBOX_BATCH_SIZE")).toThrow(
      'OUTBOX_BATCH_SIZE="0": expected an integer >= 1',
    );
    expect(readInt(config, "OUTBOX_MAX_ATTEMPTS")).toBeUndefined();
    expect(readNumber(config, "HEAP_OOM_THRESHOLD")).toBe(0.9);
    expect(readBool(config, "DATABASE_KEEPALIVE")).toBe(false);
    expect(readJson(config, "KAFKA_EXTRA_PROPERTIES")).toEqual({ debug: "all" });
    expect(readString(config, "KAFKA_BROKERS")).toBeUndefined();
  });
});
