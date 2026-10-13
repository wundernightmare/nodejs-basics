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

/**
 * The profile, or null when another one is still being taken. `signal` ends
 * the sampling early (the admin listener's shutdown): the profiler stops and
 * the call rejects with the signal's AbortError — a shutdown never waits out
 * a 60 s profile.
 */
export async function captureCpuProfile(
  durationMs: number,
  signal?: AbortSignal,
): Promise<object | null> {
  if (running) return null;
  running = true;
  const session = new Session();
  try {
    // Inside the try: a connect that throws must still release the lock, or
    // every later request is a 409.
    session.connect();
    await session.post("Profiler.enable");
    await session.post("Profiler.start");
    await delay(durationMs, undefined, signal === undefined ? {} : { signal });
    const { profile } = await session.post("Profiler.stop");
    return profile;
  } finally {
    // Disconnecting also stops a profiler that is still sampling.
    try {
      session.disconnect();
    } catch {
      // never connected
    }
    running = false;
  }
}
