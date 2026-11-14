import { ConfigService } from "@nestjs/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { meta, testCase } from "@base/testing";

import {
  buildRetryStrategy,
  buildValkeyConfig,
  toBullMqOptions,
  toClientOptions,
} from "./valkey-config.builder.js";

const config = (env: Record<string, string>): ConfigService =>
  new ConfigService({ VALKEY_URL: "redis://localhost:6379", ...env });

// ConfigService.get() reads process.env before its own values: an ambient
// VALKEY_URL (e.g. `just deps` on other ports) would leak into these cases.
const ambient = Object.entries(process.env).filter(([k]) => k.startsWith("VALKEY_"));
beforeAll(() => {
  for (const [k] of ambient) Reflect.deleteProperty(process.env, k);
});
afterAll(() => {
  for (const [k, v] of ambient) process.env[k] = v;
});

describe("valkey config builder", () => {
  meta({
    epic: "nodejs-basics",
    feature: "cache",
    owner: "@team-platform",
    tags: ["cache", "unit"],
  });

  it("parses host, port, db and credentials from VALKEY_URL", async () => {
    await testCase("NB-310", "VALKEY_URL is the baseline");
    const built = buildValkeyConfig(
      config({ VALKEY_URL: "rediss://user:pw@cache.internal:6380/2" }),
    );
    expect(built).toMatchObject({
      host: "cache.internal",
      port: 6380,
      db: 2,
      username: "user",
    });
    // Typed: the password shows itself nowhere — only to the driver's options.
    expect(built.password.expose()).toBe("pw");
    expect(JSON.stringify(built)).not.toContain('"pw"');
    expect(String(built.password)).toMatch(/^\[redacted:[0-9a-f]{8}\]$/u);
    expect(toClientOptions(built)).toMatchObject({ password: "pw" });
    expect(toBullMqOptions(built)).toMatchObject({ password: "pw" });
    expect(built.tls).toEqual({ rejectUnauthorized: true });
  });

  it("lets explicit env override URL components", async () => {
    await testCase("NB-311", "VALKEY_PASSWORD beats the URL password");
    const built = buildValkeyConfig(
      config({ VALKEY_URL: "redis://u:fromurl@localhost:6379", VALKEY_PASSWORD: "fromenv" }),
    );
    expect(built.password.expose()).toBe("fromenv");
    // Without one, none is passed to the driver at all.
    const open = buildValkeyConfig(config({}));
    expect(open.password.isSet).toBe(false);
    expect(toClientOptions(open)).not.toHaveProperty("password");
  });

  it("plaintext with three retries per request by default; no VALKEY_URL, no client", async () => {
    await testCase("NB-312", "only VALKEY_URL → defaults; without it Valkey is off");
    expect(() => buildValkeyConfig(new ConfigService({}))).toThrow("VALKEY_URL is not set");
    const built = buildValkeyConfig(config({}));
    expect(built).toMatchObject({ host: "localhost", port: 6379, db: 0, maxRetriesPerRequest: 3 });
    expect(built.tls).toBeUndefined();
  });

  it("client options fail fast when disconnected; BullMQ options never time out a command", async () => {
    await testCase("NB-313", "toClientOptions vs toBullMqOptions");
    const built = buildValkeyConfig(config({ VALKEY_COMMAND_TIMEOUT_MS: "250" }));
    const client = toClientOptions(built);
    expect(client).toMatchObject({
      commandTimeout: 250,
      socketTimeout: 10_000,
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    const bull = toBullMqOptions(built);
    expect(bull).toMatchObject({ maxRetriesPerRequest: null, enableReadyCheck: false });
    expect(bull).not.toHaveProperty("commandTimeout");
    expect(bull).not.toHaveProperty("socketTimeout"); // a blocking command is silence by design
    expect(
      toClientOptions(buildValkeyConfig(config({ VALKEY_SOCKET_TIMEOUT_MS: "0" }))),
    ).not.toHaveProperty("socketTimeout");
  });

  it("reconnect delay grows exponentially with full jitter and never stops", async () => {
    await testCase("NB-314", "retryStrategy returns a bounded number for every attempt");
    const strategy = buildRetryStrategy({ baseDelayMs: 100, maxDelayMs: 1000 });
    for (const attempt of [1, 2, 5, 50]) {
      const d = strategy(attempt);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1000);
    }
  });

  it("rejects VALKEY_EXTRA_PROPERTIES that is not a JSON object", async () => {
    await testCase("NB-315", "extra properties must be an object");
    expect(() => buildValkeyConfig(config({ VALKEY_EXTRA_PROPERTIES: "[1]" }))).toThrow(
      /JSON object/u,
    );
    expect(() => buildValkeyConfig(config({ VALKEY_EXTRA_PROPERTIES: "{" }))).toThrow(
      "VALKEY_EXTRA_PROPERTIES=…: expected a JSON object",
    );
  });
});
