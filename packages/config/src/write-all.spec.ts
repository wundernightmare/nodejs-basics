import { beforeEach, describe, expect, it, vi } from "vitest";

import { meta, testCase } from "@base/testing";

const writes: Buffer[] = [];
let behaviour: "partial" | "eagain-once" | "fail" = "partial";
let calls = 0;

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  writeSync: (_fd: number, buf: Buffer, offset: number): number => {
    calls++;
    if (behaviour === "fail") throw Object.assign(new Error("closed"), { code: "EPIPE" });
    if (behaviour === "eagain-once" && calls === 1)
      throw Object.assign(new Error("full"), { code: "EAGAIN" });
    // A pipe takes at most 4 bytes per call here.
    const chunk = buf.subarray(offset, offset + 4);
    writes.push(Buffer.from(chunk));
    return chunk.length;
  },
}));

const { writeAll } = await import("./config.loader.js");

describe("writeAll", () => {
  meta({
    epic: "nodejs-basics",
    feature: "config",
    owner: "@team-platform",
    tags: ["config", "unit"],
  });
  beforeEach(() => {
    writes.length = 0;
    calls = 0;
  });

  it("writes the whole text, however little each write takes, and waits out a full pipe", async () => {
    await testCase("NB-1001", "a flag's output is never cut short");
    behaviour = "partial";
    writeAll(1, "0123456789");
    expect(Buffer.concat(writes).toString()).toBe("0123456789");
    behaviour = "eagain-once";
    writes.length = 0;
    calls = 0;
    writeAll(1, "abc");
    expect(Buffer.concat(writes).toString()).toBe("abc");
  });

  it("any other write error is thrown", async () => {
    await testCase("NB-1002", "a closed stdout is an error, not a busy loop");
    behaviour = "fail";
    expect(() => {
      writeAll(2, "x");
    }).toThrow("closed");
  });
});
