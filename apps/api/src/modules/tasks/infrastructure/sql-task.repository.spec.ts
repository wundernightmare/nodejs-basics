import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { meta, testCase } from "@base/testing";

import { SqlTaskRepository } from "./sql-task.repository.js";

describe("SqlTaskRepository (unit)", () => {
  meta({ epic: "nodejs-basics", feature: "tasks", owner: "@team-platform", tags: ["api"] });

  it("destroys the client when ROLLBACK fails instead of pooling it", async () => {
    await testCase("NB-949", "a broken connection never goes back to the pool");
    const dead = new Error("connection terminated");
    const release = vi.fn();
    const query = vi.fn((sql: string) => {
      if (sql === "BEGIN") return Promise.resolve({ rows: [] });
      if (sql === "ROLLBACK") return Promise.reject(dead);
      return Promise.reject(new Error("insert failed"));
    });
    const pool = { connect: () => Promise.resolve({ query, release }) } as unknown as Pool;

    await expect(
      new SqlTaskRepository(pool).create({ id: "t1", title: "x", description: null }),
    ).rejects.toThrow("insert failed");
    expect(release).toHaveBeenCalledWith(dead);
  });
});
