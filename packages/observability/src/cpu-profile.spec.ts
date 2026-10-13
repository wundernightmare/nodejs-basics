import { afterEach, describe, expect, it, vi } from "vitest";

import { testCase } from "@base/testing";

// A Session whose first connect() throws (no inspector), then works.
const connect = vi.fn<() => void>();
vi.mock("node:inspector/promises", () => ({
  Session: class {
    connect = connect;
    disconnect = vi.fn();
    post = vi.fn(async (method: string) =>
      method === "Profiler.stop" ? { profile: { nodes: [] } } : {},
    );
  },
}));

const { captureCpuProfile } = await import("./cpu-profile.js");

afterEach(() => {
  connect.mockReset();
});

describe("captureCpuProfile", () => {
  it("a failed connect releases the one-profile lock", async () => {
    await testCase("NB-1032", "an inspector error is not a 409 forever");
    connect.mockImplementationOnce(() => {
      throw new Error("inspector unavailable");
    });
    await expect(captureCpuProfile(1)).rejects.toThrow("inspector unavailable");
    await expect(captureCpuProfile(1)).resolves.toEqual({ nodes: [] });
  });
});
