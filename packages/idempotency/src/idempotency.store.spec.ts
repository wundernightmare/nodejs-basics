import { describe, expect, it, vi } from "vitest";

import { meta, testCase } from "@base/testing";

import { ValkeyIdempotencyStore } from "./idempotency.store.js";

describe("ValkeyIdempotencyStore", () => {
  meta({ epic: "nodejs-basics", feature: "idempotency", owner: "@team-platform", tags: ["unit"] });

  it("maps the store operations onto Valkey commands (TTL in seconds, NX for the lock)", async () => {
    await testCase("NB-973", "idempotency store ↔ Valkey");
    const valkey = {
      get: vi.fn(() => Promise.resolve("v")),
      set: vi.fn(() => Promise.resolve(null)),
      del: vi.fn(() => Promise.resolve(1)),
    };
    const store = new ValkeyIdempotencyStore(valkey as never);
    await expect(store.get("k")).resolves.toBe("v");
    await store.set("k", "v", 60);
    await expect(store.setNx("k", "v", 60)).resolves.toBe(false);
    await store.del("k");
    expect(valkey.set.mock.calls).toEqual([
      ["k", "v", "EX", 60],
      ["k", "v", "EX", 60, "NX"],
    ]);
    expect(valkey.del).toHaveBeenCalledWith("k");
  });
});
