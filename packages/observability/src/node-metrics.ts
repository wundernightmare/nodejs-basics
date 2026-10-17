/**
 * Process and runtime metrics — the names golang-basics' Go/process
 * collectors use where one exists (process_*), base units (seconds, bytes),
 * cumulative counters. OTel observable instruments, so the values flow
 * through the shared MeterProvider to the Prometheus exporter.
 *
 * The event-loop delay and utilization are summarised over a fixed window on
 * a timer, not per collect: a scrape (or a curl of /metrics) never empties
 * another scraper's window.
 *
 * File descriptors (process_open_fds / process_max_fds) are read from /proc,
 * so they exist on Linux only — where the services run; elsewhere they are
 * not registered rather than reported as 0.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  constants,
  monitorEventLoopDelay,
  type EventLoopUtilization,
  performance,
  type PerformanceEntry,
  PerformanceObserver,
} from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";

import type { Meter } from "@opentelemetry/api";

/** How long one event-loop delay window lasts. */
export const EVENT_LOOP_WINDOW_MS = 10_000;

const GC_KIND: Record<number, string> = {
  [constants.NODE_PERFORMANCE_GC_MINOR]: "minor",
  [constants.NODE_PERFORMANCE_GC_MAJOR]: "major",
  [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: "incremental",
  [constants.NODE_PERFORMANCE_GC_WEAKCB]: "weakcb",
};

/** Open file descriptors of this process (the readdir's own fd excluded). */
export function openFds(dir = "/proc/self/fd"): number {
  return readdirSync(dir).length - 1;
}

/** The soft "Max open files" limit from a /proc/<pid>/limits text, or undefined. */
export function maxFds(limits: string): number | undefined {
  const soft = /^Max open files\s+(\S+)/mu.exec(limits)?.[1];
  if (soft === undefined || soft === "unlimited") return undefined;
  const n = Number(soft);
  return Number.isFinite(n) ? n : undefined;
}

export interface BuildIdentity {
  version: string;
  revision: string;
}

export function registerNodeMetrics(meter: Meter, build: BuildIdentity): () => void {
  // ─── Build ─────────────────────────────────────────────────────────────────

  const buildInfo = meter.createObservableGauge("build_info", {
    description: "Build identity of the running service; always 1.",
  });
  buildInfo.addCallback((result) => {
    result.observe(1, { version: build.version, revision: build.revision });
  });

  const versionInfo = meter.createObservableGauge("nodejs_version_info", {
    description: "Node.js version of the running process; always 1.",
  });
  versionInfo.addCallback((result) => {
    result.observe(1, { version: process.version });
  });

  // ─── CPU (cumulative since process start) ──────────────────────────────────

  const cpuUser = meter.createObservableCounter("process_cpu_user_seconds_total", {
    description: "User-mode CPU time consumed by the process since it started.",
    unit: "s",
  });
  const cpuSystem = meter.createObservableCounter("process_cpu_system_seconds_total", {
    description: "Kernel-mode CPU time consumed by the process since it started.",
    unit: "s",
  });
  meter.addBatchObservableCallback(
    (result) => {
      const cpu = process.cpuUsage();
      result.observe(cpuUser, cpu.user / 1e6);
      result.observe(cpuSystem, cpu.system / 1e6);
    },
    [cpuUser, cpuSystem],
  );

  const startTime = meter.createObservableGauge("process_start_time_seconds", {
    description: "Start time of the process since the Unix epoch.",
    unit: "s",
  });
  const startedAt = Math.round(Date.now() / 1000 - process.uptime());
  startTime.addCallback((result) => {
    result.observe(startedAt);
  });

  // ─── File descriptors (Linux) ───────────────────────────────────────────────

  if (process.platform === "linux" && existsSync("/proc/self/fd")) {
    const open = meter.createObservableGauge("process_open_fds", {
      description: "Open file descriptors (sockets included).",
    });
    const max = meter.createObservableGauge("process_max_fds", {
      description: "The process's open file descriptor limit (soft RLIMIT_NOFILE).",
    });
    meter.addBatchObservableCallback(
      (result) => {
        result.observe(open, openFds());
        const limit = maxFds(readFileSync("/proc/self/limits", "utf8"));
        if (limit !== undefined) result.observe(max, limit);
      },
      [open, max],
    );
  }

  // ─── Memory ────────────────────────────────────────────────────────────────

  const rss = meter.createObservableGauge("process_resident_memory_bytes", {
    description: "Resident set size of the process.",
    unit: "By",
  });
  const heapUsed = meter.createObservableGauge("nodejs_heap_used_bytes", {
    description: "V8 heap in use.",
    unit: "By",
  });
  const heapTotal = meter.createObservableGauge("nodejs_heap_total_bytes", {
    description: "V8 heap allocated.",
    unit: "By",
  });
  const heapLimit = meter.createObservableGauge("nodejs_heap_limit_bytes", {
    description: "V8 heap size limit; reaching it is an out-of-memory crash.",
    unit: "By",
  });
  const external = meter.createObservableGauge("nodejs_external_memory_bytes", {
    description: "Memory of C++ objects bound to JavaScript objects (Buffers included).",
    unit: "By",
  });
  const limit = getHeapStatistics().heap_size_limit;
  meter.addBatchObservableCallback(
    (result) => {
      const mem = process.memoryUsage();
      result.observe(rss, mem.rss);
      result.observe(heapUsed, mem.heapUsed);
      result.observe(heapTotal, mem.heapTotal);
      result.observe(heapLimit, limit);
      result.observe(external, mem.external);
    },
    [rss, heapUsed, heapTotal, heapLimit, external],
  );

  // ─── Event loop delay (fixed window) ───────────────────────────────────────

  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let window: { p50: number; p99: number; max: number } | undefined;
  const summary = (): { p50: number; p99: number; max: number } => ({
    p50: histogram.percentile(50) / 1e9,
    p99: histogram.percentile(99) / 1e9,
    max: histogram.max / 1e9,
  });
  // Event loop utilization: the share of the window the loop spent running
  // JavaScript (or native callbacks) rather than idle in the poll phase.
  const started = performance.eventLoopUtilization();
  let eluMark: EventLoopUtilization = started;
  let elu: number | undefined;
  const roll = (): void => {
    if (histogram.count > 0) window = summary();
    histogram.reset();
    const now = performance.eventLoopUtilization();
    elu = performance.eventLoopUtilization(now, eluMark).utilization;
    eluMark = now;
  };
  const timer = setInterval(roll, EVENT_LOOP_WINDOW_MS);
  timer.unref();

  const eventLoopDelay = meter.createObservableGauge("nodejs_eventloop_delay_seconds", {
    description: "Event loop delay over the last 10 s window, by quantile (0.5, 0.99, max).",
    unit: "s",
  });
  eventLoopDelay.addCallback((result) => {
    // Before the first window closes: the samples so far (read, not reset).
    const w = window ?? (histogram.count > 0 ? summary() : undefined);
    if (w === undefined) return;
    result.observe(w.p50, { quantile: "0.5" });
    result.observe(w.p99, { quantile: "0.99" });
    result.observe(w.max, { quantile: "max" });
  });

  const utilization = meter.createObservableGauge("nodejs_eventloop_utilization", {
    description: "Share of the last 10 s window the event loop was busy (0..1).",
  });
  utilization.addCallback((result) => {
    // Before the first window closes: since start.
    result.observe(elu ?? performance.eventLoopUtilization(started).utilization);
  });

  // ─── GC ────────────────────────────────────────────────────────────────────

  const gcDuration = meter.createHistogram("nodejs_gc_duration_seconds", {
    description: "Garbage collection pauses, by kind (minor, major, incremental, weakcb).",
    unit: "s",
    advice: {
      explicitBucketBoundaries: [
        0.0001, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1,
      ],
    },
  });
  const gcObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const kind = (entry as PerformanceEntry & { detail?: { kind?: number } }).detail?.kind;
      gcDuration.record(entry.duration / 1000, {
        kind: (kind !== undefined ? GC_KIND[kind] : undefined) ?? "other",
      });
    }
  });
  gcObserver.observe({ entryTypes: ["gc"] });

  return () => {
    clearInterval(timer);
    histogram.disable();
    gcObserver.disconnect();
  };
}
