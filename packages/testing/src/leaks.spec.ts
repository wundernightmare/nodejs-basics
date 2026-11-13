import { describe, expect, it } from "vitest";

import { leaked } from "./leaks.setup.js";
import { testCase } from "./meta.js";

describe("leak check", () => {
  it("reports only what there is more of than before", async () => {
    await testCase("NB-1230", "leak check: handles left by a spec file fail it");
    const before = new Map([
      ["Timeout", 1],
      ["TCPServerWrap", 1],
    ]);
    expect(leaked(before, new Map(before))).toBe("");
    expect(leaked(before, new Map([["Timeout", 1]]))).toBe("");
    expect(
      leaked(
        before,
        new Map([
          ["Timeout", 3],
          ["TCPServerWrap", 1],
          ["TCPSocketWrap", 1],
        ]),
      ),
    ).toBe("1× TCPSocketWrap, 2× Timeout");
  });
});
