import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { testCase } from "@base/testing";

import { AfterCommitError, PgUnitOfWork, TxOptionsError } from "./pg-unit-of-work.service.js";
import { afterCommit, currentTransaction } from "./transaction.storage.js";

/**
 * The control flow of the unit of work against a pool that only records what
 * it was sent: which statements frame the callback, when hooks run, what is
 * retried. What Postgres does with those statements is the integration suite.
 */
function fakePool(failOn: Array<{ sql: RegExp; code: string; times: number }> = []): {
  pool: Pool;
  sent: string[];
  released: boolean[];
} {
  const sent: string[] = [];
  const released: boolean[] = [];
  const client = {
    query: (sql: string) => {
      sent.push(sql);
      const failure = failOn.find((f) => f.times > 0 && f.sql.test(sql));
      if (failure !== undefined) {
        failure.times--;
        return Promise.reject(Object.assign(new Error(failure.code), { code: failure.code }));
      }
      return Promise.resolve({ command: sql.split(" ")[0], rows: [] });
    },
    release: (broken?: boolean) => {
      released.push(broken === true);
    },
  };
  return { pool: { connect: () => Promise.resolve(client) } as unknown as Pool, sent, released };
}

async function exec(sql: string): Promise<void> {
  await currentTransaction<{ query(sql: string): Promise<unknown> }>()!.query(sql);
}

describe("PgUnitOfWork — options", () => {
  it("opens the transaction at the requested isolation level", async () => {
    await testCase("NB-1128", "unit of work: isolation level");
    const { pool, sent } = fakePool();
    await new PgUnitOfWork(pool).runInTransaction(() => exec("W"), { isolation: "serializable" });
    expect(sent).toEqual(["BEGIN ISOLATION LEVEL SERIALIZABLE", "W", "COMMIT"]);
  });

  it.each(["40001", "40P01"])("runs the callback again after %s", async (code) => {
    await testCase("NB-1129", "unit of work: retry on serialization failure and deadlock");
    const { pool, sent, released } = fakePool([{ sql: /^W$/u, code, times: 2 }]);
    let runs = 0;
    const result = await new PgUnitOfWork(pool).runInTransaction(
      async () => {
        runs++;
        await exec("W");
        return "done";
      },
      { retries: 2 },
    );
    expect([result, runs]).toEqual(["done", 3]);
    expect(sent).toEqual([
      "BEGIN",
      "W",
      "ROLLBACK",
      "BEGIN",
      "W",
      "ROLLBACK",
      "BEGIN",
      "W",
      "COMMIT",
    ]);
    expect(released).toEqual([false, false, false]);
  });

  it("gives up after `retries`, and does not retry other errors or without the option", async () => {
    await testCase("NB-1129", "unit of work: retry on serialization failure and deadlock");
    const exhausted = fakePool([{ sql: /^W$/u, code: "40001", times: 9 }]);
    await expect(
      new PgUnitOfWork(exhausted.pool).runInTransaction(() => exec("W"), { retries: 1 }),
    ).rejects.toMatchObject({ code: "40001" });
    expect(exhausted.sent.filter((s) => s === "BEGIN")).toHaveLength(2);

    const other = fakePool([{ sql: /^W$/u, code: "23505", times: 9 }]);
    await expect(
      new PgUnitOfWork(other.pool).runInTransaction(() => exec("W"), { retries: 3 }),
    ).rejects.toMatchObject({ code: "23505" });
    expect(other.sent.filter((s) => s === "BEGIN")).toHaveLength(1);

    const plain = fakePool([{ sql: /^W$/u, code: "40001", times: 9 }]);
    await expect(
      new PgUnitOfWork(plain.pool).runInTransaction(() => exec("W")),
    ).rejects.toMatchObject({ code: "40001" });
    expect(plain.sent.filter((s) => s === "BEGIN")).toHaveLength(1);
  });

  it("a nested unit cannot ask for retries or a stricter isolation level", async () => {
    await testCase("NB-1130", "unit of work: a nested unit cannot outbid the outer one");
    const { pool } = fakePool();
    const uow = new PgUnitOfWork(pool);
    await expect(
      uow.runInTransaction(() => uow.runInTransaction(() => exec("W"), { retries: 1 })),
    ).rejects.toBeInstanceOf(TxOptionsError);
    await expect(
      uow.runInTransaction(() =>
        uow.runInTransaction(() => exec("W"), { isolation: "repeatable read" }),
      ),
    ).rejects.toBeInstanceOf(TxOptionsError);
    await expect(
      uow.runInTransaction(
        () => uow.runInTransaction(() => exec("W"), { isolation: "serializable" }),
        { isolation: "repeatable read" },
      ),
    ).rejects.toBeInstanceOf(TxOptionsError);
    // The same or a weaker level is what the outer transaction already gives.
    await uow.runInTransaction(
      async () => {
        await uow.runInTransaction(() => exec("W"), { isolation: "serializable" });
        await uow.runInTransaction(() => exec("W"), { isolation: "read committed" });
      },
      { isolation: "serializable" },
    );
  });

  it("a nested unit with a savepoint undoes only itself", async () => {
    await testCase("NB-1131", "unit of work: savepoints");
    const { pool, sent } = fakePool();
    const uow = new PgUnitOfWork(pool);
    await uow.runInTransaction(async () => {
      await exec("A");
      await uow.runInTransaction(() => exec("B"), { savepoint: true });
      await uow
        .runInTransaction(
          async () => {
            await exec("C");
            throw new Error("undo C");
          },
          { savepoint: true },
        )
        .catch(() => {});
      await exec("D");
    });
    expect(sent).toEqual([
      "BEGIN",
      "A",
      "SAVEPOINT uow_1",
      "B",
      "RELEASE SAVEPOINT uow_1",
      "SAVEPOINT uow_2",
      "C",
      "ROLLBACK TO SAVEPOINT uow_2",
      "D",
      "COMMIT",
    ]);
  });
});

describe("afterCommit", () => {
  it("runs at once outside a unit of work", async () => {
    await testCase("NB-1132", "afterCommit: after the outermost commit, never after a rollback");
    const ran: string[] = [];
    await afterCommit(() => {
      ran.push("now");
    });
    expect(ran).toEqual(["now"]);
  });

  it("runs after the outermost commit, in order, outside the transaction", async () => {
    await testCase("NB-1132", "afterCommit: after the outermost commit, never after a rollback");
    const { pool, sent } = fakePool();
    const uow = new PgUnitOfWork(pool);
    const order: string[] = [];
    await uow.runInTransaction(async () => {
      await afterCommit(() => {
        order.push(`first after ${sent.at(-1)}, tx=${String(currentTransaction())}`);
      });
      await uow.runInTransaction(async () => {
        await afterCommit(async () => {
          await Promise.resolve();
          order.push("second");
        });
      });
      order.push("body");
    });
    expect(order).toEqual(["body", "first after COMMIT, tx=undefined", "second"]);
  });

  it("does not run for a transaction that rolled back, nor for a rolled-back savepoint", async () => {
    await testCase("NB-1132", "afterCommit: after the outermost commit, never after a rollback");
    const { pool } = fakePool();
    const uow = new PgUnitOfWork(pool);
    const ran: string[] = [];
    await expect(
      uow.runInTransaction(async () => {
        await afterCommit(() => {
          ran.push("rolled back");
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await uow.runInTransaction(async () => {
      await afterCommit(() => {
        ran.push("outer");
      });
      await uow.runInTransaction(() => afterCommit(() => void ran.push("kept savepoint")), {
        savepoint: true,
      });
      await uow
        .runInTransaction(
          async () => {
            await afterCommit(() => {
              ran.push("undone savepoint");
            });
            throw new Error("undo");
          },
          { savepoint: true },
        )
        .catch(() => {});
    });
    expect(ran).toEqual(["outer", "kept savepoint"]);
  });

  it("runs the hooks of the attempt that committed only", async () => {
    await testCase("NB-1133", "afterCommit and retries: one set of hooks per commit");
    const { pool } = fakePool([{ sql: /^W$/u, code: "40001", times: 1 }]);
    let hooks = 0;
    await new PgUnitOfWork(pool).runInTransaction(
      async () => {
        await afterCommit(() => {
          hooks++;
        });
        await exec("W");
      },
      { retries: 1 },
    );
    expect(hooks).toBe(1);
  });

  it("a failing hook does not stop the others and is reported as AfterCommitError", async () => {
    await testCase("NB-1134", "afterCommit: a hook cannot undo the commit");
    const { pool, sent } = fakePool();
    const ran: string[] = [];
    const failure = new Error("cache down");
    const outcome = await new PgUnitOfWork(pool)
      .runInTransaction(async () => {
        await afterCommit(() => {
          throw failure;
        });
        await afterCommit(() => {
          ran.push("second");
        });
      })
      .catch((err: unknown) => err);
    expect(outcome).toBeInstanceOf(AfterCommitError);
    expect((outcome as AfterCommitError).errors).toEqual([failure]);
    expect((outcome as AfterCommitError).cause).toBe(failure);
    expect(ran).toEqual(["second"]);
    expect(sent).toEqual(["BEGIN", "COMMIT"]);
  });
});
