import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { meta, testCase } from "@base/testing";

import { SecretFileWatcher } from "./secret-file-watcher.js";

let dir: string;
let path: string;
let watcher: SecretFileWatcher | undefined;

/** Rewrite the secret and push its mtime forward so the next poll sees a change. */
function rotate(content: string): void {
  writeFileSync(path, content);
  utimesSync(path, new Date(), new Date(Date.now() + 1000));
}

/** A watcher on a 50 ms poll, started under fake timers. */
function started(): SecretFileWatcher {
  vi.useFakeTimers();
  watcher = new SecretFileWatcher({ path, name: "TEST", pollIntervalMs: 50 });
  watcher.start();
  return watcher;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nb-secret-watcher-"));
  path = join(dir, "password");
  writeFileSync(path, "initial-secret\n");
});

afterEach(() => {
  watcher?.stop();
  watcher = undefined;
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("SecretFileWatcher", () => {
  meta({
    epic: "nodejs-basics",
    feature: "config",
    owner: "@team-platform",
    tags: ["config", "unit"],
  });

  it("reads the file at construction and trims trailing newlines", async () => {
    await testCase("NB-779", "current() is valid before the first poll");
    writeFileSync(path, "initial-secret\r\n\n");
    watcher = new SecretFileWatcher({ path, name: "TEST" });
    expect(watcher.current()).toBe("initial-secret");
  });

  it("throws at construction when the file does not exist — misconfig surfaces at boot", async () => {
    await testCase("NB-780", "missing secret file fails fast");
    expect(() => new SecretFileWatcher({ path: join(dir, "missing"), name: "TEST" })).toThrow();
  });

  it("emits a change event with next and previous content on rotation", async () => {
    await testCase("NB-781", "rotation notifies listeners");
    const w = started();
    const changes: Array<[string, string]> = [];
    w.onChange((next, prev) => {
      changes.push([next, prev]);
    });

    rotate("rotated-secret\n");
    vi.advanceTimersByTime(60);

    expect(changes).toEqual([["rotated-secret", "initial-secret"]]);
    expect(w.current()).toBe("rotated-secret");
  });

  it("does not fire when mtime changes but the content stays the same", async () => {
    await testCase("NB-782", "kubelet re-projection of an identical secret is a no-op");
    const w = started();
    const cb = vi.fn();
    w.onChange(cb);

    rotate("initial-secret\n");
    vi.advanceTimersByTime(60);

    expect(cb).not.toHaveBeenCalled();
  });

  it("isolates listener exceptions — one bad consumer doesn't break the others", async () => {
    await testCase("NB-783", "a throwing listener does not stop delivery");
    const w = started();
    const good = vi.fn();
    w.onChange(() => {
      throw new Error("boom");
    });
    w.onChange(good);

    rotate("rotated\n");
    vi.advanceTimersByTime(60);

    expect(good).toHaveBeenCalledExactlyOnceWith("rotated", "initial-secret");
  });

  it("onChange returns an unsubscribe handle", async () => {
    await testCase("NB-784", "unsubscribe stops notifications");
    const w = started();
    const cb = vi.fn();
    const unsubscribe = w.onChange(cb);
    unsubscribe();

    rotate("rotated\n");
    vi.advanceTimersByTime(60);

    expect(cb).not.toHaveBeenCalled();
  });

  it("stop() halts the timer", async () => {
    await testCase("NB-785", "stop ends polling");
    const w = started();
    w.stop();
    const cb = vi.fn();
    w.onChange(cb);

    rotate("rotated\n");
    vi.advanceTimersByTime(500);

    expect(cb).not.toHaveBeenCalled();
    expect(w.current()).toBe("initial-secret");
  });

  it("stop() also drops the listeners registered before it", async () => {
    await testCase("NB-786", "stop releases listeners");
    const w = started();
    const cb = vi.fn();
    w.onChange(cb);
    w.stop();
    w.start();

    rotate("rotated\n");
    vi.advanceTimersByTime(60);

    expect(cb).not.toHaveBeenCalled();
    expect(w.current()).toBe("rotated");
  });

  it("start() is idempotent — re-entry doesn't double the timer", async () => {
    await testCase("NB-787", "double start keeps one timer");
    const w = started();
    w.start();
    const cb = vi.fn();
    w.onChange(cb);

    rotate("rotated\n");
    vi.advanceTimersByTime(60);

    expect(cb).toHaveBeenCalledOnce();
  });

  it("survives a failed poll (file briefly gone) and picks up the next rotation", async () => {
    await testCase("NB-788", "a poll error is logged, not thrown");
    const w = started();
    const cb = vi.fn();
    w.onChange(cb);

    rmSync(path);
    expect(() => {
      vi.advanceTimersByTime(60);
    }).not.toThrow();
    expect(w.current()).toBe("initial-secret");

    rotate("rotated\n");
    vi.advanceTimersByTime(60);
    expect(cb).toHaveBeenCalledExactlyOnceWith("rotated", "initial-secret");
  });
});
