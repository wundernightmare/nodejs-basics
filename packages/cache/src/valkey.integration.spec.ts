import { ConfigService } from "@nestjs/config";
import { Redis as Valkey } from "iovalkey";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { integration, meta, testCase, unique } from "@base/testing";

import { buildValkeyConfig, toBullMqOptions, toClientOptions } from "./valkey-config.builder.js";

/**
 * The client the provider builds, against a real Valkey (VALKEY_URL from
 * `just deps` or the CI service): the option bag connects, round-trips a
 * value with a TTL, and the BullMQ variant survives a blocking command
 * longer than the command timeout — the regression behind
 * `toBullMqOptions` dropping `commandTimeout`.
 */
const infra = integration("valkey");

describe.skipIf(infra.skip)("valkey client (integration)", () => {
  meta({
    epic: "nodejs-basics",
    feature: "cache",
    owner: "@team-platform",
    tags: ["cache", "integration"],
  });

  const prefix = unique("cache");
  let client: Valkey;

  beforeAll(async () => {
    process.env["VALKEY_URL"] = infra.url("valkey");
    const built = buildValkeyConfig(new ConfigService());
    client = new Valkey(toClientOptions(built));
    await client.connect();
  });

  afterAll(async () => {
    const keys = await client.keys(`${prefix}:*`);
    if (keys.length > 0) await client.del(...keys);
    await client.quit();
  });

  it("round-trips a value with a TTL", async () => {
    await testCase("NB-301", "set / get / ttl / del against Valkey");
    const key = `${prefix}:k1`;
    await client.set(key, "v1", "EX", 60);
    expect(await client.get(key)).toBe("v1");
    expect(await client.ttl(key)).toBeGreaterThan(0);
    await client.del(key);
    expect(await client.get(key)).toBeNull();
  });

  it("BullMQ options let a blocking command outlive the command timeout", async () => {
    await testCase("NB-302", "toBullMqOptions has no per-command timeout");
    process.env["VALKEY_COMMAND_TIMEOUT_MS"] = "200";
    try {
      const built = buildValkeyConfig(new ConfigService());
      const opts = toBullMqOptions(built);
      expect(opts).not.toHaveProperty("commandTimeout");
      const blocking = new Valkey(opts);
      await blocking.connect();
      try {
        // BLPOP with a 1 s server-side timeout: longer than the 200 ms
        // command timeout the regular client would enforce. It must return
        // null (no element), not throw "Command timed out".
        const started = Date.now();
        await expect(blocking.blpop(`${prefix}:queue`, 1)).resolves.toBeNull();
        expect(Date.now() - started).toBeGreaterThanOrEqual(900);
      } finally {
        await blocking.quit();
      }
    } finally {
      delete process.env["VALKEY_COMMAND_TIMEOUT_MS"];
    }
  });
});
