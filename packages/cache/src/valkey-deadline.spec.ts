import type { Redis as Valkey } from "iovalkey";
import { describe, expect, it } from "vitest";

import { DeadlineExceededError, withDeadline } from "@base/common";
import { meta, testCase } from "@base/testing";

import { guardValkeyClient } from "./valkey-deadline.js";

interface Cmd {
  promise: Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

function command(): Cmd {
  const cmd = {} as Cmd;
  cmd.promise = new Promise((resolve, reject) => {
    cmd.resolve = resolve;
    cmd.reject = reject;
  });
  return cmd;
}

function guarded(): { client: Valkey; sent: Cmd[] } {
  const sent: Cmd[] = [];
  const client = {
    sendCommand(c: Cmd) {
      sent.push(c);
      return c.promise;
    },
  } as unknown as Valkey;
  return { client: guardValkeyClient(client), sent };
}

const send = (client: Valkey, c: Cmd): unknown =>
  (client as unknown as { sendCommand(c: Cmd): unknown }).sendCommand(c);

describe("valkey deadline", () => {
  meta({
    epic: "nodejs-basics",
    feature: "deadlines",
    owner: "@team-platform",
    tags: ["cache", "deadline", "unit"],
  });

  it("rejects without sending once the budget is spent", async () => {
    await testCase("NB-621", "spent budget → DeadlineExceededError, not sent");
    const { client, sent } = guarded();
    const c = command();
    withDeadline(0, () => send(client, c));
    await expect(c.promise).rejects.toThrow(DeadlineExceededError);
    expect(sent).toHaveLength(0);
  });

  it("stops waiting for a reply when the budget runs out, and leaves unbudgeted commands alone", async () => {
    await testCase("NB-622", "no reply within the budget → DeadlineExceededError");
    const { client, sent } = guarded();
    const slow = command();
    withDeadline(30, () => send(client, slow));
    await expect(slow.promise).rejects.toThrow(DeadlineExceededError);

    const plain = command();
    send(client, plain);
    plain.resolve("OK");
    await expect(plain.promise).resolves.toBe("OK");
    expect(sent).toHaveLength(2);
  });
});
