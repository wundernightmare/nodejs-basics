import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { meta, testCase } from "@base/testing";

import { SEMCONV_SCHEMA_URL } from "./setup-telemetry.js";

describe("telemetry schema URL", () => {
  meta({
    epic: "nodejs-basics",
    feature: "observability",
    owner: "@team-platform",
    tags: ["tracing", "unit"],
  });

  it("names the semantic-conventions version the code is built against", async () => {
    await testCase("NB-1000", "an upgrade of the conventions moves the declared schema with it");
    const require = createRequire(import.meta.url);
    const entry = require.resolve("@opentelemetry/semantic-conventions");
    let dir = dirname(entry);
    while (!dir.endsWith("semantic-conventions")) dir = dirname(dir);
    const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      version: string;
    };
    expect(SEMCONV_SCHEMA_URL).toBe(`https://opentelemetry.io/schemas/${version}`);
  });
});
