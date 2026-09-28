import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import { DeadlineExceededError, withDeadline } from "@base/common";
import { meta, testCase } from "@base/testing";

import { guardPgPool, limitTransaction } from "./pg-deadline.js";

/** A pool stand-in: `connect` hands the listener a client whose query() answers `reply`. */
function guardedClient(reply: unknown = { rows: [] }): { client: PoolClient; sent: unknown[] } {
  const sent: unknown[] = [];
  const client = {
    query(...args: unknown[]): unknown {
      sent.push(args[0]);
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    },
  } as unknown as PoolClient;
  let listener: ((c: PoolClient) => void) | undefined;
  guardPgPool({ on: (_: string, fn: (c: PoolClient) => void) => (listener = fn) } as never);
  listener?.(client);
  return { client, sent };
}

describe("pg deadline", () => {
  meta({
    epic: "nodejs-basics",
    feature: "deadlines",
    owner: "@team-platform",
    tags: ["database", "deadline", "unit"],
  });

  it("sends nothing once the budget is spent, and passes through without one", async () => {
    await testCase("NB-611", "spent budget → DeadlineExceededError, no query");
    const { client, sent } = guardedClient();
    await withDeadline(0, () =>
      expect(client.query("SELECT 1")).rejects.toThrow(DeadlineExceededError),
    );
    expect(sent).toEqual([]);
    await client.query("SELECT 2");
    expect(sent).toEqual(["SELECT 2"]);
  });

  it("turns the server's statement cancel into DeadlineExceededError under a deadline only", async () => {
    await testCase("NB-612", "SQLSTATE 57014 → 504 under a deadline, as is otherwise");
    const canceled = Object.assign(new Error("canceling statement due to statement timeout"), {
      code: "57014",
    });
    const { client } = guardedClient(canceled);
    await withDeadline(5_000, () =>
      expect(client.query("SELECT pg_sleep(9)")).rejects.toThrow(DeadlineExceededError),
    );
    await expect(client.query("SELECT pg_sleep(9)")).rejects.toBe(canceled);
  });

  it("limits a transaction to the rest of the budget with SET LOCAL statement_timeout", async () => {
    await testCase("NB-613", "unit of work: statement_timeout = remaining ms");
    const { client, sent } = guardedClient();
    await limitTransaction(client);
    expect(sent).toEqual([]);
    await withDeadline(1_500, () => limitTransaction(client));
    expect(String(sent[0])).toMatch(/^SET LOCAL statement_timeout = (1[0-4]\d\d|1500)$/u);
  });
});
