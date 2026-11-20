import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { testCase } from "@base/testing";

import { writeCrashReport } from "./crash-report.service.js";

describe("CrashReportService report", () => {
  it("keeps the diagnostic data but never writes the process environment", async () => {
    await testCase("NB-1383", "Crash diagnostics: environment credentials stay out of the report");
    const dir = mkdtempSync(join(tmpdir(), "crash-report-"));
    const path = join(dir, "report.json");
    process.env["CRASH_REPORT_TEST_CREDENTIAL"] = "not-for-the-report";
    try {
      writeCrashReport(path);
      const text = readFileSync(path, "utf8");
      const report = JSON.parse(text) as { header?: unknown; environmentVariables?: unknown };
      expect(report.header).toBeDefined();
      expect(report.environmentVariables).toBeUndefined();
      expect(text.includes("not-for-the-report")).toBe(false);
    } finally {
      delete process.env["CRASH_REPORT_TEST_CREDENTIAL"];
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
