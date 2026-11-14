/**
 * guardBackground — the wrapper for work nobody awaits: a relay loop, a
 * reconnect loop, a timer callback. Such a task handles its expected failures
 * itself (log, back off, try again); what escapes it is a bug, and without a
 * wrapper a bug there is either an unhandled rejection that kills the process
 * mid-request or, worse, a loop that silently never runs again.
 *
 * A throw (or rejection) that reaches the guard is:
 *   1. counted — `background_panics_total{task}`;
 *   2. logged at error with the stack (`event.action: background.panic`),
 *      whatever the log level;
 *   3. turned into an orderly stop: by default the process sends itself
 *      SIGTERM with exit code 1, so the usual shutdown runs (readiness off,
 *      in-flight work drained, connections closed) and the orchestrator
 *      restarts a process whose state can no longer be trusted.
 *
 * The returned function never throws and never rejects. `task` is a metric
 * label: pass a constant. Mirrors Server.Guard in golang-basics' libs/httpx.
 */
import { metrics } from "@opentelemetry/api";

import { withDebugLogging } from "@base/common";

import { ecsError, pinoLogger } from "./pino.config.js";

export interface GuardLogger {
  error(obj: object, msg: string): void;
}

export interface GuardOptions {
  logger?: GuardLogger;
  /** What "stop the process in order" means; the default signals SIGTERM with exit code 1. */
  onFatal?: (err: unknown, task: string) => void;
}

/** Marks an error that came out of a guarded background task. */
export class BackgroundPanicError extends Error {
  constructor(
    readonly task: string,
    override readonly cause: unknown,
  ) {
    super(
      `background task "${task}": panic: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "BackgroundPanicError";
  }
}

function stopInOrder(): void {
  process.exitCode = 1;
  process.kill(process.pid, "SIGTERM");
}

export function guardBackground<A extends unknown[]>(
  task: string,
  fn: (...args: A) => unknown,
  options: GuardOptions = {},
): (...args: A) => Promise<void> {
  const logger = options.logger ?? pinoLogger;
  const onFatal = options.onFatal ?? stopInOrder;
  // Stryker disable next-line StringLiteral: the meter's name is not exported
  const panics = metrics.getMeter("background").createCounter("background_panics_total", {
    description: "Unexpected errors that escaped a background task, by task.",
  });

  return async (...args: A): Promise<void> => {
    try {
      await fn(...args);
    } catch (err) {
      panics.add(1, { task });
      // Marked context: this record must land whatever the level is.
      withDebugLogging(() => {
        logger.error(
          { ...ecsError(err), "event.action": "background.panic", "background.task": task },
          "Panic in background task — stopping the process",
        );
      });
      try {
        onFatal(new BackgroundPanicError(task, err), task);
      } catch {
        // The stop itself failed: nothing sensible is left to do here.
      }
    }
  };
}
