import { describe, expect, it, vi } from "vitest";

import { testCase } from "@base/testing";

import { containerMemoryLimit, memoryBudget, reportMemoryBudget } from "./runtime-memory.js";

const MIB = 1024 * 1024;

describe("container memory budget", () => {
  it("reads 'no limit' however the platform spells it", async () => {
    await testCase("NB-1204", "runtime: the container memory limit is read from the cgroup");
    expect(containerMemoryLimit(() => 0)).toBeUndefined();
    expect(containerMemoryLimit(() => 2 ** 64)).toBeUndefined();
    expect(containerMemoryLimit(() => Number.NaN)).toBeUndefined();
    expect(containerMemoryLimit(() => 512 * MIB)).toBe(512 * MIB);
  });

  it("flags a heap limit the container cannot hold", async () => {
    await testCase("NB-1205", "runtime: a heap limit above the container budget is reported");
    expect(memoryBudget(0.75, 512 * MIB, 256 * MIB)).toEqual({
      containerLimitBytes: 512 * MIB,
      heapLimitBytes: 256 * MIB,
      heapShare: 0.5,
      verdict: "ok",
      suggestedMaxOldSpaceMb: 384,
    });
    expect(memoryBudget(0.75, 512 * MIB, 384 * MIB).verdict).toBe("ok"); // exactly the ratio
    expect(memoryBudget(0.75, 512 * MIB, 4096 * MIB)).toMatchObject({
      verdict: "heap_over_container",
      heapShare: 8,
      suggestedMaxOldSpaceMb: 384,
    });
    expect(memoryBudget(0.75, undefined, 4096 * MIB)).toMatchObject({
      verdict: "unlimited",
      heapShare: undefined,
      suggestedMaxOldSpaceMb: undefined,
    });
  });

  it("warns only when the heap can outgrow the container", async () => {
    await testCase("NB-1205", "runtime: a heap limit above the container budget is reported");
    const logger = {
      info: vi.fn<(o: Record<string, unknown>, m: string) => void>(),
      warn: vi.fn<(o: Record<string, unknown>, m: string) => void>(),
    };
    reportMemoryBudget(logger, memoryBudget(0.75, undefined, 4096 * MIB));
    reportMemoryBudget(logger, memoryBudget(0.75, 512 * MIB, 256 * MIB));
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(2);

    reportMemoryBudget(logger, memoryBudget(0.75, 512 * MIB, 4096 * MIB));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        "container.memory.limit_bytes": 512 * MIB,
        "process.heap.suggested_max_old_space_mb": 384,
      }),
      expect.stringContaining("--max-old-space-size"),
    );
  });
});
