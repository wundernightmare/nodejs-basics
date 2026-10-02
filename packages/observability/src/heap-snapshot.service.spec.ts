import { existsSync, rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { AppLogger, pinoLogger } from "@base/logger";
import { meta, testCase } from "@base/testing";

import { HeapSnapshotService } from "./heap-snapshot.service.js";

const logger = new AppLogger(pinoLogger.child({}, { level: "silent" }));

describe("HeapSnapshotService", () => {
  meta({
    epic: "nodejs-basics",
    feature: "observability",
    owner: "@team-platform",
    tags: ["observability"],
  });
  const written: string[] = [];
  afterEach(() => {
    for (const path of written.splice(0)) rmSync(path, { force: true });
  });

  it("listens for SIGUSR2 while running, and stops on shutdown", async () => {
    await testCase("NB-950", "heap snapshot trigger lifecycle");
    const before = process.listenerCount("SIGUSR2");
    const svc = new HeapSnapshotService(logger);
    svc.onApplicationBootstrap();
    expect(process.listenerCount("SIGUSR2")).toBe(before + 1);
    svc.onApplicationShutdown();
    expect(process.listenerCount("SIGUSR2")).toBe(before);
  });

  it("writes a snapshot locally without S3, and skips a capture while one runs", async () => {
    await testCase("NB-951", "manual heap snapshot");
    const svc = new HeapSnapshotService(logger);
    const first = svc.capture("manual");
    const second = await svc.capture("manual"); // the first holds the flag
    const path = await first;
    if (path !== null) written.push(path);
    expect(second).toBeNull();
    expect(path).toMatch(/heap-.*-manual\.heapsnapshot$/u);
    expect(existsSync(String(path))).toBe(true);
  }, 30_000);
});
