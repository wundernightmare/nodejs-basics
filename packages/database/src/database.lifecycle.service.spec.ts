import { type Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { type SecretFileWatcher } from "@base/config";
import { meta, testCase } from "@base/testing";

import { DatabaseLifecycleService } from "./database.lifecycle.service.js";

const pool = (): Pool => ({ end: vi.fn(async () => undefined) }) as unknown as Pool;

describe("DatabaseLifecycleService", () => {
  meta({
    epic: "nodejs-basics",
    feature: "database",
    owner: "@team-platform",
    tags: ["database"],
  });

  it("ends both pools and stops the password watcher", async () => {
    await testCase("NB-905", "database pools are closed on shutdown");
    const primary = pool();
    const replica = pool();
    const watcher = { stop: vi.fn() } as unknown as SecretFileWatcher;
    await new DatabaseLifecycleService(primary, replica, watcher).onApplicationShutdown();
    expect(primary.end).toHaveBeenCalledOnce();
    expect(replica.end).toHaveBeenCalledOnce();
    expect(watcher.stop).toHaveBeenCalledOnce();
  });

  it("ends an aliased read-only pool once, and a second shutdown is a no-op", async () => {
    await testCase("NB-906", "database shutdown is idempotent");
    const primary = pool();
    const svc = new DatabaseLifecycleService(primary, primary, null);
    await svc.onApplicationShutdown();
    await svc.onApplicationShutdown();
    expect(primary.end).toHaveBeenCalledOnce();
  });

  it("a failing pool.end does not stop the other pool from closing", async () => {
    await testCase("NB-907", "database shutdown tolerates a failing pool");
    const primary = {
      end: vi.fn(async () => Promise.reject(new Error("boom"))),
    } as unknown as Pool;
    const replica = pool();
    await new DatabaseLifecycleService(primary, replica, null).onApplicationShutdown();
    expect(replica.end).toHaveBeenCalledOnce();
  });
});
