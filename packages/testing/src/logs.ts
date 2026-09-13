import { Writable } from "node:stream";

import { pino, type Logger, type LoggerOptions } from "pino";

export interface LogCapture {
  /** A real pino logger (JSON, synchronous) writing into memory. */
  logger: Logger;
  /** Every record written so far, parsed. */
  lines(): Record<string, unknown>[];
  /** The first record matching `pred`, or undefined. */
  find(pred: (rec: Record<string, unknown>) => boolean): Record<string, unknown> | undefined;
  /** Forget everything captured so far. */
  reset(): void;
}

/**
 * A real logger whose output a test can assert on — the counterpart of the
 * Go sibling's `testx.LogBuffer`. Records are parsed JSON, so a test checks
 * fields (`rec["request_id"]`, `rec["level"]`), not string fragments.
 */
export function captureLogs(opts: LoggerOptions = {}): LogCapture {
  const raw: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      raw.push(chunk.toString());
      cb();
    },
  });
  const logger = pino({ level: "trace", ...opts }, sink);
  const lines = (): Record<string, unknown>[] =>
    raw
      .join("")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return {
    logger,
    lines,
    find: (pred) => lines().find((rec) => pred(rec)),
    reset: () => {
      raw.length = 0;
    },
  };
}
