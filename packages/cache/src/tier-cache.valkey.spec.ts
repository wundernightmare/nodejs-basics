import { EventEmitter } from "node:events";

import type { Redis as Valkey } from "iovalkey";
import { describe, expect, it, vi } from "vitest";

import { testCase } from "@base/testing";

import { ValkeyRemote } from "./tier-cache.valkey.js";

/** The connection `duplicate()` hands a subscription: events in, subscribe / disconnect out. */
class FakeConnection extends EventEmitter {
  readonly subscribe = vi.fn<(channel: string) => Promise<number>>();
  readonly disconnect = vi.fn<(reconnect?: boolean) => void>();
}

function remote() {
  const connection = new FakeConnection();
  const duplicate = vi.fn(() => connection);
  const warnings: object[] = [];
  const client = { duplicate } as unknown as Valkey;
  const logger = {
    warn(fields: object) {
      warnings.push(fields);
    },
  };
  return { connection, duplicate, warnings, valkey: new ValkeyRemote(client, { logger }) };
}

const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("ValkeyRemote subscription", () => {
  it("subscribes on every ready and reports each acknowledgement", async () => {
    await testCase("NB-1271", "Tier cache L2: resubscribes by hand on every ready");
    const { connection, duplicate, valkey } = remote();
    connection.subscribe.mockResolvedValue(1);
    const messages: string[] = [];
    let acknowledged = 0;
    const stop = await valkey.subscribe(
      "inv",
      (message) => messages.push(message),
      () => {
        acknowledged += 1;
      },
    );
    // A connection of its own, resubscribed by hand: the acknowledgement is the signal.
    expect(duplicate).toHaveBeenCalledWith(
      expect.objectContaining({ autoResubscribe: false, enableOfflineQueue: false }),
    );

    connection.emit("ready");
    await settled();
    connection.emit("ready"); // after a reconnect
    await settled();
    expect(connection.subscribe).toHaveBeenCalledTimes(2);
    expect(acknowledged).toBe(2);

    connection.emit("message", "inv", "k1");
    connection.emit("message", "other", "k2");
    expect(messages).toEqual(["k1"]);

    await stop();
    expect(connection.disconnect).toHaveBeenCalledWith();
  });

  it("a subscription the server did not acknowledge starts over on a fresh connection", async () => {
    await testCase("NB-1272", "Tier cache L2: an unacknowledged subscription reconnects");
    const { connection, warnings, valkey } = remote();
    connection.subscribe.mockRejectedValue(new Error("connection closed"));
    let acknowledged = 0;
    await valkey.subscribe(
      "inv",
      () => {},
      () => {
        acknowledged += 1;
      },
    );

    connection.emit("ready");
    await settled();
    // Not a state to stay in: reconnect, and the next "ready" subscribes again.
    expect(connection.disconnect).toHaveBeenCalledWith(true);
    expect(acknowledged).toBe(0);

    connection.emit("error", new Error("ECONNRESET"));
    expect(warnings).toEqual([{ "cache.channel": "inv", "error.message": "ECONNRESET" }]);
  });
});
