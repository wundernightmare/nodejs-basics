import { describe, expect, it } from "vitest";

import { meta, testCase } from "@base/testing";

import { KAFKA_SEND_ERRORS, KafkaSendError, toKafkaSendError } from "./kafka-errors.js";

const lib = (code: number, extra: object = {}): Error =>
  Object.assign(new Error(`code ${code}`), { code, ...extra });

describe("kafka send error registry", () => {
  meta({ epic: "nodejs-basics", feature: "kafka", owner: "@team-platform", tags: ["kafka"] });

  it.each([
    [-184, "queue_full", true],
    [-192, "unavailable", true],
    [6, "unavailable", true],
    [3, "not_provisioned", true],
    [29, "not_provisioned", true],
    [10, "rejected", false],
    [87, "rejected", false],
    [12_345, "unknown", true],
  ])("code %i → %s (retryable %s)", async (code, kind, retryable) => {
    await testCase("NB-936", "librdkafka codes map onto the registry");
    const err = toKafkaSendError(lib(code));
    expect(err).toBeInstanceOf(KafkaSendError);
    expect(err).toMatchObject({ kind, retryable, code });
    expect((err.cause as Error).message).toBe(`code ${code}`);
  });

  it("a fatal error wins over its code; an error without a code is unknown and retryable", async () => {
    await testCase("NB-937", "fatal and unrecognised errors");
    expect(toKafkaSendError(lib(10, { fatal: true })).kind).toBe("fatal");
    expect(toKafkaSendError(new Error("boom"))).toMatchObject({ kind: "unknown", retryable: true });
    const already = new KafkaSendError("queue_full");
    expect(toKafkaSendError(already)).toBe(already);
  });

  it("no code belongs to two kinds", async () => {
    await testCase("NB-938", "the registry is unambiguous");
    const codes: number[] = Object.values(KAFKA_SEND_ERRORS).flatMap((s) => s.codes);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
