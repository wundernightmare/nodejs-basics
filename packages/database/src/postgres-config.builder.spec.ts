import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";

import { meta, testCase } from "@base/testing";

import { buildPostgresConfig } from "./postgres-config.builder.js";

describe("buildPostgresConfig", () => {
  meta({ epic: "nodejs-basics", feature: "database", owner: "@team-platform", tags: ["database"] });

  it("puts the DATABASE_PASSWORD_FILE password into the connection string, over the URL's", async () => {
    await testCase("NB-977", "the mounted password wins and reaches pg and libpq alike");
    const dir = mkdtempSync(join(tmpdir(), "nb-pg-password-"));
    try {
      const file = join(dir, "password");
      writeFileSync(file, "n@w#pass\n");
      const { poolOptions } = buildPostgresConfig(
        new ConfigService({
          DATABASE_URL: "postgresql://app:old@localhost:5432/app",
          DATABASE_PASSWORD_FILE: file,
        }),
      );
      // pg-connection-string lets the query parameter win over the URL's userinfo.
      expect(new URL(String(poolOptions.connectionString)).searchParams.get("password")).toBe(
        "n@w#pass",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
