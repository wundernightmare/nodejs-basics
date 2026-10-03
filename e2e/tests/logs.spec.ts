import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { LOG_EVENTS } from "@base/logger/log-events";
import { logEnvelopeProblems } from "@base/testing/log-envelope";

import { E2E, meta, testCase } from "../fixtures/meta.js";
import { LOG_DIR, SPAWN } from "../fixtures/services.js";
import { API_ADMIN_URL, WORKER_ADMIN_URL } from "../helpers/env.js";

const read = (name: string): string[] =>
  fs.readFileSync(path.join(LOG_DIR, `${name}.log`), "utf8").split("\n");

const FEATURE = { ...E2E, feature: "health & observability" };

test.describe("log contract", () => {
  // The spawned api and worker write their output to files; the stack's
  // containers log to Docker, out of reach here.
  test.skip(!SPAWN, "needs the spawned services (E2E_SPAWN=1)");

  test("every line the services write keeps the envelope; events are catalogued", async ({
    request,
  }) => {
    await meta(FEATURE);
    await testCase("NB-999", "a log pipeline can parse every line, a rule can match every event");
    // The harness runs the services at warn; a minute at info gives the
    // check request lines, and the change and reset are catalogued events.
    const admins = [API_ADMIN_URL, WORKER_ADMIN_URL];
    const raised = await Promise.all(
      admins.map((admin) => request.put(`${admin}/admin/log-level?level=info&ttl=1m`)),
    );
    expect(raised.map((r) => r.status())).toEqual([200, 200]);
    await request.get("/health");
    const reset = await Promise.all(
      admins.map((admin) => request.delete(`${admin}/admin/log-level`)),
    );
    expect(reset.map((r) => r.status())).toEqual([200, 200]);
    await expect
      .poll(() =>
        ["api", "worker"].every((name) =>
          read(name).some((l) => l.includes('"event.action":"log_level.reset"')),
        ),
      )
      .toBe(true);
    const actions = new Set(LOG_EVENTS.map((e) => e.action));
    const problems: string[] = [];
    let checked = 0;
    for (const name of ["api", "worker"]) {
      for (const [i, raw] of read(name).entries()) {
        if (raw.trim() === "") continue;
        // Node's own warnings (deprecations) go to stderr in plain text.
        if (/^\(node:\d+\) /u.test(raw) || raw.startsWith("(Use `node --trace-")) continue;
        checked++;
        let line: Record<string, unknown>;
        try {
          line = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          problems.push(`${name}:${i + 1} is not JSON: ${raw.slice(0, 80)}`);
          continue;
        }
        for (const p of logEnvelopeProblems(line)) problems.push(`${name}:${i + 1} ${p}`);
        const action = line["event.action"];
        if (typeof action === "string" && !actions.has(action))
          problems.push(`${name}:${i + 1} event.action ${action} is not in the catalog`);
      }
    }
    expect(checked).toBeGreaterThan(5); // the services did log
    expect(problems).toEqual([]);
  });
});
