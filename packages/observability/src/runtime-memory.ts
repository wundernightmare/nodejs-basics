/**
 * The V8 heap limit against the memory limit of the container the process
 * actually runs in — Node's counterpart of the memory limiter in
 * golang-basics' libs/httpx/runtime.go.
 *
 * Go moves its soft limit at run time; V8's heap limit is fixed when the
 * process starts (--max-old-space-size, or a default V8 derives from the
 * cgroup limit), so what can be done here is to check and to say:
 *
 *   - the heap limit above `ratio` × the container limit means the kernel
 *     OOM-kills the container before V8 collects under pressure — no heap
 *     snapshot, no "near OOM" warning, just exit code 137. Buffers and native
 *     memory live outside the heap, so the heap must leave room for them;
 *   - the suggested --max-old-space-size is `ratio` × the limit, to be set
 *     where the container's resources are set (and changed with them).
 *
 * The container limit is re-read on every scrape
 * (nodejs_container_memory_limit_bytes): an in-place resize or a VPA changes
 * it without a restart, and then the two gauges drift apart on the dashboard.
 */
import { getHeapStatistics } from "node:v8";

/** cgroup "no limit" comes back as 0 or as a number nothing real is near. */
const UNLIMITED = 2 ** 60;

export const DEFAULT_HEAP_LIMIT_RATIO = 0.75;

export interface MemoryBudget {
  /** The cgroup memory limit; undefined when there is none. */
  containerLimitBytes: number | undefined;
  heapLimitBytes: number;
  /** heap limit / container limit; undefined without a container limit. */
  heapShare: number | undefined;
  verdict: "unlimited" | "ok" | "heap_over_container";
  /** What --max-old-space-size (MiB) keeps the heap within `ratio` of the container. */
  suggestedMaxOldSpaceMb: number | undefined;
}

/** The container's memory limit in bytes, or undefined when the process is not limited. */
export function containerMemoryLimit(
  read: () => number = () => process.constrainedMemory(),
): number | undefined {
  const limit = read();
  return Number.isFinite(limit) && limit > 0 && limit < UNLIMITED ? limit : undefined;
}

export function memoryBudget(
  ratio: number = DEFAULT_HEAP_LIMIT_RATIO,
  containerLimitBytes: number | undefined = containerMemoryLimit(),
  heapLimitBytes: number = getHeapStatistics().heap_size_limit,
): MemoryBudget {
  if (containerLimitBytes === undefined) {
    return {
      containerLimitBytes,
      heapLimitBytes,
      heapShare: undefined,
      verdict: "unlimited",
      suggestedMaxOldSpaceMb: undefined,
    };
  }
  const heapShare = heapLimitBytes / containerLimitBytes;
  return {
    containerLimitBytes,
    heapLimitBytes,
    heapShare,
    verdict: heapShare > ratio ? "heap_over_container" : "ok",
    suggestedMaxOldSpaceMb: Math.floor((containerLimitBytes * ratio) / (1024 * 1024)),
  };
}

export interface BudgetLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** Logs the budget once at boot: info when it fits, warn when the heap can outgrow the container. */
export function reportMemoryBudget(
  logger: BudgetLogger,
  budget: MemoryBudget = memoryBudget(),
): void {
  if (budget.verdict === "unlimited") {
    logger.info(
      { "process.heap.limit_bytes": budget.heapLimitBytes },
      "No container memory limit found, V8 heap limit left as it is",
    );
    return;
  }
  const fields = {
    "container.memory.limit_bytes": budget.containerLimitBytes,
    "process.heap.limit_bytes": budget.heapLimitBytes,
    "process.heap.container_share": Number((budget.heapShare ?? 0).toFixed(3)),
    "process.heap.suggested_max_old_space_mb": budget.suggestedMaxOldSpaceMb,
  };
  if (budget.verdict === "heap_over_container") {
    logger.warn(
      fields,
      "V8 heap limit leaves no room in the container: it will be OOM-killed before the heap limit is reached — set --max-old-space-size",
    );
    return;
  }
  logger.info(fields, "V8 heap limit fits the container memory limit");
}
