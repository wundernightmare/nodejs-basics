import { describe, expect, it, vi } from "vitest";

import { captureMetrics, metricValue, testCase } from "@base/testing";

import { BackgroundPanicError, guardBackground } from "./background-guard.js";

function harness() {
  const records: Array<{ fields: Record<string, unknown>; message: string }> = [];
  const logger = {
    error(fields: object, message: string) {
      records.push({ fields: fields as Record<string, unknown>, message });
    },
  };
  const onFatal = vi.fn<(err: unknown, task: string) => void>();
  return { records, logger, onFatal };
}

describe("guardBackground", () => {
  it("turns a bug in a background task into a count, a log line with the stack and an orderly stop", async () => {
    await testCase("NB-1249", "Guard: a panic in a background task stops the process in order");
    const capture = captureMetrics();
    const { records, logger, onFatal } = harness();
    const rows: number[] = [];
    const relay = guardBackground(
      "outbox-relay",
      async (index: number) => {
        await Promise.resolve();
        rows.push((undefined as unknown as number[])[index]!); // a real TypeError
      },
      { logger, onFatal },
    );

    await expect(relay(3)).resolves.toBeUndefined(); // never rejects

    const scraped = await capture.scrape();
    expect(metricValue(scraped, "background_panics_total", { task: "outbox-relay" })).toBe(1);
    expect(scraped).toContain(
      "# HELP background_panics_total Unexpected errors that escaped a background task, by task.",
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.message).toBe("Panic in background task — stopping the process");
    expect(records[0]?.fields).toMatchObject({
      "event.action": "background.panic",
      "background.task": "outbox-relay",
      "error.type": "TypeError",
    });
    expect(String(records[0]?.fields["error.stack_trace"])).toContain("background-guard.spec");

    expect(onFatal).toHaveBeenCalledTimes(1);
    const [err, task] = onFatal.mock.calls[0]!;
    expect(task).toBe("outbox-relay");
    expect(err).toBeInstanceOf(BackgroundPanicError);
    expect((err as Error).name).toBe("BackgroundPanicError");
    expect((err as BackgroundPanicError).message).toMatch(
      /^background task "outbox-relay": panic: /u,
    );
    expect((err as BackgroundPanicError).cause).toBeInstanceOf(TypeError);
    await capture.stop();
  });

  it("a task that returns — synchronously or not — is not a panic", async () => {
    await testCase("NB-1250", "Guard: a normal return counts nothing and stops nothing");
    const capture = captureMetrics();
    const { records, logger, onFatal } = harness();
    await guardBackground("a", () => 1, { logger, onFatal })();
    await guardBackground("b", async () => {}, { logger, onFatal })();

    expect(await capture.scrape()).not.toMatch(/background_panics_total\{/u);
    expect(records).toHaveLength(0);
    expect(onFatal).not.toHaveBeenCalled();
    await capture.stop();
  });

  it("a synchronous throw and a failing stop are both contained", async () => {
    await testCase("NB-1251", "Guard: the wrapper itself never throws");
    const { records, logger } = harness();
    const guarded = guardBackground(
      "timer",
      () => {
        throw new Error("boom");
      },
      {
        logger,
        onFatal: () => {
          throw new Error("stop failed");
        },
      },
    );
    await expect(guarded()).resolves.toBeUndefined();
    expect(records).toHaveLength(1);
  });

  it("by default the process is told to terminate itself with a failing exit code", async () => {
    await testCase("NB-1252", "Guard: the default stop is SIGTERM with exit code 1");
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const before = process.exitCode;
    try {
      await guardBackground(
        "default-stop",
        () => {
          throw new Error("boom");
        },
        { logger: { error() {} } },
      )();
      expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = before;
      kill.mockRestore();
    }
  });
});
