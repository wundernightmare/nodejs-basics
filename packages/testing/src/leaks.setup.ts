/**
 * Leak check of the unit layer — vitest setup file. After a spec file's tests
 * it fails the file when something the tests started still keeps the event
 * loop alive: a server never closed, a socket, an interval, a child process.
 * The counterpart of golang-basics' testx.Main (goleak) — there a goroutine,
 * here a handle.
 *
 * Only what holds the loop open counts (process.getActiveResourcesInfo): an
 * unref'ed timer or a promise that never settles keeps nothing alive and is
 * not reported — which is why this is not vitest's detectAsyncLeaks, which
 * reports every such promise, a library's module-level ones included.
 *
 * Handles that are just finishing (a closed server's socket) get a moment:
 * the check retries before it fails. LEAK_CHECK=trace adds where each leaked
 * handle was created (slower: every async resource gets a stack);
 * LEAK_CHECK=off switches the check off.
 */
import { createHook } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { afterAll } from "vitest";

/** Not the tests': the runner's own channel to its parent, stdio, and the check's own timer. */
const IGNORED = new Set(["MessagePort", "PipeWrap", "TTYWrap", "FSReqPromise", "FSReqCallback"]);

/**
 * How long finishing handles get. The integration layer gives more
 * (LEAK_CHECK_GRACE_MS): a Valkey client whose connection was already cut
 * keeps a 2 s timer of its own after disconnect().
 */
const GRACE_MS = Number(process.env["LEAK_CHECK_GRACE_MS"] ?? 1_000);

function census(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const type of process.getActiveResourcesInfo()) {
    if (!IGNORED.has(type)) counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return counts;
}

/** What `now` has more of than `before`, as "2× Timeout, 1× TCPSocketWrap". */
export function leaked(before: Map<string, number>, now: Map<string, number>): string {
  const extra: string[] = [];
  for (const [type, count] of now) {
    const more = count - (before.get(type) ?? 0);
    if (more > 0) extra.push(`${more}× ${type}`);
  }
  return extra.toSorted().join(", ");
}

/** LEAK_CHECK=trace: the creation stack of every live async resource, by id. */
function traceCreations(): () => string {
  const live = new Map<number, { type: string; stack: string }>();
  createHook({
    init(id, type) {
      if (IGNORED.has(type) || type === "PROMISE" || type === "TickObject") return;
      live.set(id, { type, stack: new Error("created here").stack ?? "" });
    },
    destroy(id) {
      live.delete(id);
    },
  }).enable();
  return () =>
    [...live.values()]
      .map(({ type, stack }) => `${type}\n${stack.split("\n").slice(2, 12).join("\n")}`)
      .join("\n\n");
}

if (process.env["LEAK_CHECK"] !== "off") {
  const trace = process.env["LEAK_CHECK"] === "trace" ? traceCreations() : undefined;
  const before = census();

  afterAll(async () => {
    const until = Date.now() + GRACE_MS;
    let extra = leaked(before, census());
    while (extra !== "" && Date.now() < until) {
      // The wait itself is a Timeout: one of ours on top of the baseline.
      await delay(25);
      extra = leaked(before, census());
    }
    if (extra !== "") {
      throw new Error(
        `leak check: the tests of this file left handles that keep the process alive: ${extra}. ` +
          "Close what they started (server.close(), client.quit(), clearInterval, vi.useRealTimers())." +
          (trace === undefined
            ? " Run with LEAK_CHECK=trace to see where they were created."
            : `\n\nLive async resources:\n\n${trace()}`),
      );
    }
  });
}
