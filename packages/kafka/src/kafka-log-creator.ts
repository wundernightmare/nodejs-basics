import { KafkaJS } from "@confluentinc/kafka-javascript";

import { pinoLogger } from "@base/logger";

type Level = "error" | "warn" | "info" | "debug";

/** Window in which a repeated line is counted instead of written. */
export const REPEAT_WINDOW_MS = 60_000;
const MAX_TRACKED = 1_000;

interface Seen {
  writtenAt: number;
  suppressed: number;
}

/**
 * The bridge between kafka-javascript / librdkafka logging and pino.
 *
 * - The library's extras `{ fac, name, timestamp }` become
 *   `kafka.log.facility` / `kafka.client.name`; `timestamp` is dropped
 *   (`@timestamp` is ours).
 * - Repeats are folded: librdkafka logs every failed connect attempt (per
 *   address family, ~20 lines/s per client while a broker is down) and the
 *   binding re-logs each error event. A line identical to one written less
 *   than REPEAT_WINDOW_MS ago — same level, facility, client, and text with
 *   its numbers masked ("after 0ms" vs "after 3ms") — is only counted; the
 *   next one written after the window carries `kafka.log.suppressed` = how
 *   many were folded into it.
 * - Level: librdkafka is told INFO (kafkajs-compat default); the runtime log
 *   level and withDebugLogging() do not reach it. For a deep dive set
 *   KAFKA_EXTRA_PROPERTIES='{"debug":"broker,protocol"}'.
 */
export function createKafkaLogger(
  log: Pick<typeof pinoLogger, Level> = pinoLogger,
  namespace = "kafka-javascript",
  now: () => number = Date.now,
  seen: Map<string, Seen> = new Map(),
): KafkaJS.Logger {
  const write = (level: Level, message: string, extraArg?: object): void => {
    const extra = extraArg as Record<string, unknown> | undefined;
    const fields: Record<string, unknown> = { "log.logger": `kafka:${namespace}` };
    const fac = extra?.["fac"];
    const name = extra?.["name"];
    if (typeof fac === "string" && fac !== "") fields["kafka.log.facility"] = fac;
    if (typeof name === "string" && name !== "") fields["kafka.client.name"] = name;
    for (const [k, v] of Object.entries(extra ?? {})) {
      if (k !== "fac" && k !== "name" && k !== "timestamp") fields[k] = v;
    }

    const key = [level, fac, name, message.replaceAll(/\d+/gu, "#")].join("\u0000");
    const at = now();
    const prior = seen.get(key);
    if (prior !== undefined && at - prior.writtenAt < REPEAT_WINDOW_MS) {
      prior.suppressed++;
      return;
    }
    if (prior !== undefined && prior.suppressed > 0) {
      fields["kafka.log.suppressed"] = prior.suppressed;
    }
    seen.delete(key);
    seen.set(key, { writtenAt: at, suppressed: 0 });
    // Bounded: forget the oldest line once too many distinct ones were seen.
    if (seen.size > MAX_TRACKED) {
      const oldest = seen.keys().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    log[level](fields, message);
  };
  return {
    info: (message, extra) => {
      write("info", message, extra);
    },
    warn: (message, extra) => {
      write("warn", message, extra);
    },
    error: (message, extra) => {
      write("error", message, extra);
    },
    debug: (message, extra) => {
      write("debug", message, extra);
    },
    namespace: (ns) => createKafkaLogger(log, `${namespace}:${ns}`, now, seen),
    setLogLevel: (_level) => {
      /* pino level is controlled globally */
    },
  };
}

/**
 * Routes all internal kafka-javascript / librdkafka logs through pino.
 * Pass as `logger` in every `new KafkaJS.Kafka()` constructor:
 *
 *   new KafkaJS.Kafka({ kafkaJS: { ..., logger: kafkaLogger } })
 */
export const kafkaLogger: KafkaJS.Logger = createKafkaLogger();
