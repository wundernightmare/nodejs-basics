import { ConfigService } from "@nestjs/config";
import { Redis as Valkey } from "iovalkey";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { integration, meta, proxied, testCase } from "@base/testing";
import type { ServiceProxy } from "@base/testing";

import { buildValkeyConfig, toClientOptions } from "./valkey-config.builder.js";

/**
 * The shared client against a Valkey that goes silent without closing the
 * connection (a peer behind a dropped NAT entry, a frozen node): the command
 * timeout fails the command either way; only the socket timeout gets rid of
 * the dead connection.
 */
const infra = integration("valkey", "toxiproxy");

describe.skipIf(infra.skip)("Valkey client under connection faults (integration)", () => {
  meta({
    epic: "nodejs-basics",
    feature: "cache",
    owner: "@team-platform",
    tags: ["cache", "chaos", "integration"],
  });

  let proxy: ServiceProxy;
  const clients: Valkey[] = [];

  /** A client built the way the application builds it, through the proxy. */
  async function client(
    socketTimeoutMs: number,
  ): Promise<{ valkey: Valkey; closes: () => number }> {
    const built = buildValkeyConfig(
      new ConfigService({
        VALKEY_URL: proxy.url,
        VALKEY_COMMAND_TIMEOUT_MS: "300",
        VALKEY_SOCKET_TIMEOUT_MS: String(socketTimeoutMs),
        VALKEY_MAX_RETRIES_PER_REQUEST: "0",
        VALKEY_RECONNECT_BASE_DELAY_MS: "50",
        VALKEY_RECONNECT_MAX_DELAY_MS: "100",
      }),
    );
    const valkey = new Valkey(toClientOptions(built));
    valkey.on("error", () => {});
    let closes = 0;
    valkey.on("close", () => {
      closes += 1;
    });
    clients.push(valkey);
    await valkey.connect();
    return { valkey, closes: () => closes };
  }

  beforeAll(async () => {
    proxy = await proxied("valkey");
  });

  afterEach(async () => {
    await proxy.reset();
    for (const valkey of clients.splice(0)) valkey.disconnect();
  });

  it("a connection that went silent is dropped at the socket timeout and replaced; without one it is kept", async () => {
    await testCase("NB-1265", "Valkey: VALKEY_SOCKET_TIMEOUT_MS drops a silent connection");
    const guarded = await client(600);
    const control = await client(0);
    expect(await guarded.valkey.ping()).toBe("PONG");
    expect(await control.valkey.ping()).toBe("PONG");

    // Nothing comes back and nothing closes: the peer is simply gone.
    await proxy.toxic("timeout", { timeout: 0 });
    await expect(guarded.valkey.get("k")).rejects.toThrow(/timed out/iu);
    await expect(control.valkey.get("k")).rejects.toThrow(/timed out/iu);

    await expect.poll(guarded.closes, { timeout: 3000 }).toBeGreaterThanOrEqual(1);
    expect(control.closes()).toBe(0);
    expect(control.valkey.status).toBe("ready"); // still holding the dead connection

    // The path heals: the client that dropped its connection is back on a new one.
    await proxy.reset();
    await expect
      .poll(async () => guarded.valkey.ping().catch(() => "down"), { timeout: 5000 })
      .toBe("PONG");
  });
});
