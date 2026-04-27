/**
 * Node.js default process/runtime metrics collected via the OTEL metrics API.
 *
 * Equivalent in spirit to prom-client's collectDefaultMetrics(), implemented
 * using OTEL observable instruments so the values flow through the shared
 * MeterProvider and are exported by the Prometheus exporter.
 */
import { PerformanceObserver, monitorEventLoopDelay } from "node:perf_hooks";

import type { Meter } from "@opentelemetry/api";

export function registerNodeMetrics(meter: Meter): void {
  // ─── Memory ────────────────────────────────────────────────────────────────

  const heapUsed = meter.createObservableGauge("nodejs.heap.size.used", {
    description: "Process heap used in bytes",
    unit: "By",
  });
  const heapTotal = meter.createObservableGauge("nodejs.heap.size.total", {
    description: "Process heap total in bytes",
    unit: "By",
  });
  const rss = meter.createObservableGauge("nodejs.process.rss", {
    description: "Resident set size of the Node.js process in bytes",
    unit: "By",
  });
  const external = meter.createObservableGauge("nodejs.process.memory.external", {
    description: "Memory used by C++ objects bound to JavaScript objects in bytes",
    unit: "By",
  });
  const arrayBuffers = meter.createObservableGauge("nodejs.process.memory.array_buffers", {
    description: "Memory allocated for ArrayBuffers and SharedArrayBuffers in bytes",
    unit: "By",
  });

  meter.addBatchObservableCallback(
    (result) => {
      const mem = process.memoryUsage();
      result.observe(heapUsed, mem.heapUsed);
      result.observe(heapTotal, mem.heapTotal);
      result.observe(rss, mem.rss);
      result.observe(external, mem.external);
      result.observe(arrayBuffers, mem.arrayBuffers);
    },
    [heapUsed, heapTotal, rss, external, arrayBuffers],
  );

  // ─── CPU ───────────────────────────────────────────────────────────────────

  let prevCpu = process.cpuUsage();

  const cpuUser = meter.createObservableCounter("nodejs.process.cpu.user", {
    description: "Total user-mode CPU time consumed by the process in microseconds",
    unit: "us",
  });
  const cpuSystem = meter.createObservableCounter("nodejs.process.cpu.system", {
    description: "Total kernel-mode CPU time consumed by the process in microseconds",
    unit: "us",
  });

  meter.addBatchObservableCallback(
    (result) => {
      const cpu = process.cpuUsage(prevCpu);
      prevCpu = process.cpuUsage();
      result.observe(cpuUser, cpu.user);
      result.observe(cpuSystem, cpu.system);
    },
    [cpuUser, cpuSystem],
  );

  // ─── Uptime ────────────────────────────────────────────────────────────────

  const uptime = meter.createObservableGauge("nodejs.process.uptime", {
    description: "Number of seconds the Node.js process has been running",
    unit: "s",
  });

  uptime.addCallback((result) => {
    result.observe(process.uptime());
  });

  // ─── Event loop lag ────────────────────────────────────────────────────────

  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();

  const eventLoopMin = meter.createObservableGauge("nodejs.eventloop.delay.min", {
    description: "Minimum recorded event loop delay in nanoseconds",
    unit: "ns",
  });
  const eventLoopMax = meter.createObservableGauge("nodejs.eventloop.delay.max", {
    description: "Maximum recorded event loop delay in nanoseconds",
    unit: "ns",
  });
  const eventLoopMean = meter.createObservableGauge("nodejs.eventloop.delay.mean", {
    description: "Mean recorded event loop delay in nanoseconds",
    unit: "ns",
  });
  const eventLoopP99 = meter.createObservableGauge("nodejs.eventloop.delay.p99", {
    description: "99th percentile event loop delay in nanoseconds",
    unit: "ns",
  });

  meter.addBatchObservableCallback(
    (result) => {
      result.observe(eventLoopMin, histogram.min);
      result.observe(eventLoopMax, histogram.max);
      result.observe(eventLoopMean, histogram.mean);
      result.observe(eventLoopP99, histogram.percentile(99));
      histogram.reset();
    },
    [eventLoopMin, eventLoopMax, eventLoopMean, eventLoopP99],
  );

  // ─── GC durations ──────────────────────────────────────────────────────────

  const gcDuration = meter.createHistogram("nodejs.gc.duration", {
    description: "Garbage collection duration in milliseconds",
    unit: "ms",
  });

  const gcObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const detail = (entry as PerformanceEntry & { detail?: { kind?: string } }).detail;
      gcDuration.record(entry.duration, { gc_type: detail?.kind ?? "unknown" });
    }
  });

  gcObserver.observe({ type: "gc" });

  // ─── Active handles / requests ────────────────────────────────────────────

  const activeHandles = meter.createObservableGauge("nodejs.active_handles", {
    description: "Number of active libuv handles",
  });
  const activeRequests = meter.createObservableGauge("nodejs.active_requests", {
    description: "Number of active libuv requests",
  });

  meter.addBatchObservableCallback(
    (result) => {
      const proc = process as typeof process & {
        _getActiveHandles?: () => unknown[];
        _getActiveRequests?: () => unknown[];
      };
      result.observe(activeHandles, proc._getActiveHandles?.()?.length ?? 0);
      result.observe(activeRequests, proc._getActiveRequests?.()?.length ?? 0);
    },
    [activeHandles, activeRequests],
  );

  // ─── Node.js version info ─────────────────────────────────────────────────

  const versionInfo = meter.createObservableGauge("nodejs.version_info", {
    description: "Node.js version metadata (value always 1)",
  });

  const { major, minor, patch } = parseVersion(process.version);
  versionInfo.addCallback((result) => {
    result.observe(1, { major: String(major), minor: String(minor), patch: String(patch) });
  });
}

function parseVersion(v: string): { major: number; minor: number; patch: number } {
  const [major = 0, minor = 0, patch = 0] = v.replace("v", "").split(".").map(Number);
  return { major, minor, patch };
}
