import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";

import { meta, testCase } from "@base/testing";

import { buildPostgresConfig } from "./postgres-config.builder.js";

function buildWithNative(native: boolean) {
  return buildPostgresConfig(
    new ConfigService({
      DATABASE_URL: "postgresql://app:app@localhost:5432/app?sslmode=verify-full",
      DATABASE_SSL_CA_PEM: "test-ca",
      DATABASE_USE_NATIVE: native,
    }),
  );
}

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

  it("keeps the explicit TLS options ahead of sslmode for pure-JS pg", async () => {
    await testCase("NB-1381", "Postgres TLS: the URL cannot discard the configured CA");
    const pure = buildWithNative(false);
    expect(new URL(String(pure.poolOptions.connectionString)).searchParams.has("sslmode")).toBe(
      false,
    );
    expect(pure.poolOptions.ssl).toEqual({ ca: Buffer.from("test-ca"), rejectUnauthorized: true });
    expect(
      new URL(String(buildWithNative(true).poolOptions.connectionString)).searchParams.get(
        "sslmode",
      ),
    ).toBe("verify-full");
  });
});
