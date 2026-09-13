import { describe, expect, it } from "vitest";

import { problemDetail } from "./problem-detail.js";
import {
  getRequestId,
  isDebugLogging,
  isValidRequestId,
  withDebugLogging,
  withRequestId,
} from "./request-context.js";

describe("isValidRequestId", () => {
  it("accepts 1–128 printable non-space ASCII characters", () => {
    expect(isValidRequestId("X7K2P9M4")).toBe(true);
    expect(isValidRequestId("01J8Z1K5Q3-abc_def.ghi")).toBe(true);
    expect(isValidRequestId("a".repeat(128))).toBe(true);
  });

  it("rejects empty, too long, whitespace, control and non-ASCII values", () => {
    expect(isValidRequestId("")).toBe(false);
    expect(isValidRequestId("a".repeat(129))).toBe(false);
    expect(isValidRequestId("has space")).toBe(false);
    expect(isValidRequestId("tab\there")).toBe(false);
    expect(isValidRequestId("new\nline")).toBe(false);
    expect(isValidRequestId("ünïcode")).toBe(false);
    expect(isValidRequestId(undefined)).toBe(false);
    expect(isValidRequestId(42)).toBe(false);
  });
});

describe("withDebugLogging / isDebugLogging", () => {
  it("is off outside a marked context and on inside, including async continuations", async () => {
    expect(isDebugLogging()).toBe(false);
    const inside = await withDebugLogging(async () => {
      await Promise.resolve();
      return isDebugLogging();
    });
    expect(inside).toBe(true);
    expect(isDebugLogging()).toBe(false);
  });
});

describe("problemDetail", () => {
  it("builds an RFC 9457 body with the request_id extension from the context", () => {
    const body = withRequestId("REQ1", () =>
      problemDetail(404, "no such task", { instance: "/x" }),
    );
    expect(body).toEqual({
      type: "about:blank",
      title: "Not Found",
      status: 404,
      detail: "no such task",
      instance: "/x",
      request_id: "REQ1",
    });
    expect(getRequestId()).toBeUndefined();
  });

  it("omits request_id and detail when absent and falls back to a generic title", () => {
    expect(problemDetail(418)).toEqual({ type: "about:blank", title: "Error", status: 418 });
  });
});
