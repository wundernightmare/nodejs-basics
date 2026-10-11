/**
 * CPU profile of the running process for `durationMs`, through the V8
 * inspector of this very process (node:inspector — no debugger port is
 * opened). The result is a `.cpuprofile` JSON: open it in Chrome DevTools
 * (Performance → Load profile) or speedscope. The counterpart of Go's
 * /debug/pprof/profile; POST /debug/cpu-profile on the admin listener.
 *
 * Sampling costs a few percent of CPU while it runs and nothing otherwise.
 * One profile at a time per process: the inspector has one profiler.
 */
import { Session } from "node:inspector/promises";
import { setTimeout as delay } from "node:timers/promises";

let running = false;

/** The profile, or null when another one is still being taken. */
export async function captureCpuProfile(durationMs: number): Promise<object | null> {
  if (running) return null;
  running = true;
  const session = new Session();
  session.connect();
  try {
    await session.post("Profiler.enable");
    await session.post("Profiler.start");
    await delay(durationMs);
    const { profile } = await session.post("Profiler.stop");
    return profile;
  } finally {
    session.disconnect();
    running = false;
  }
}
