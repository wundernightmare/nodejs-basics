/**
 * The log lines meant for machines — what a log-based alert, a SIEM rule or an
 * audit query may match on. Each carries `event.action` with one of these
 * values and the fields listed; their meaning and fields are a contract like
 * a metric's (add freely, rename or remove over two releases). Every other
 * line is for people and free to change.
 *
 * log-events.spec.ts fails on an `event.action` in code that is not here, an
 * entry no code emits, and a field its source never writes;
 * `--log-events-reference` prints the list. Data only — no imports.
 */

export interface LogEvent {
  /** The `event.action` value. */
  action: string;
  level: "info" | "warn" | "error" | "fatal";
  description: string;
  /** Fields the line carries besides the envelope (docs/log-envelope.schema.json). */
  fields: readonly string[];
  /** The package or app that writes it. */
  source: string;
}

export const LOG_EVENTS: readonly LogEvent[] = [
  {
    action: "config.invalid",
    level: "fatal",
    description:
      "The configuration did not validate; the process exits 78. `message` lists every problem.",
    fields: [],
    source: "packages/config",
  },
  {
    action: "admin.started",
    level: "info",
    description:
      "The admin listener is up. `admin.auth` is `off` when ADMIN_TOKEN is unset — its " +
      "mutations (log level, heap dumps) are then open to anyone who reaches the port.",
    fields: ["server.port", "admin.auth"],
    source: "packages/observability",
  },
  {
    action: "admin.auth.rejected",
    level: "warn",
    description: "A mutation on the admin listener without a valid bearer token was refused.",
    fields: ["http.request.method", "url.path", "client.address"],
    source: "packages/observability",
  },
  {
    action: "log_level.changed",
    level: "warn",
    description: "Someone changed the log level through the admin listener, for a while.",
    fields: [
      "log.level.from",
      "log.level.to",
      "log.level.ttl_ms",
      "log.level.expires_at",
      "client.address",
    ],
    source: "packages/observability",
  },
  {
    action: "log_level.reset",
    level: "warn",
    description: "Someone reverted the log level to the configured one.",
    fields: ["log.level.from", "log.level.to", "client.address"],
    source: "packages/observability",
  },
  {
    action: "log_level.expired",
    level: "warn",
    description: "A temporary log level ran out and reverted to the configured one.",
    fields: ["log.level.from", "log.level.to"],
    source: "packages/logger",
  },
  {
    action: "outbox.rejected",
    level: "warn",
    description:
      "Kafka rejected outbox rows for good (too large, invalid); they count towards " +
      "OUTBOX_MAX_ATTEMPTS and end up in `outbox.dead`.",
    fields: ["error.code", "error.message", "outbox.poison", "outbox.failed", "outbox.sent"],
    source: "packages/outbox",
  },
  {
    action: "outbox.deferred",
    level: "warn",
    description:
      "Outbox rows were not published this pass for a passing reason (queue full, broker " +
      "unreachable) and are kept for the next one.",
    fields: ["error.code", "error.message", "outbox.failed", "outbox.sent"],
    source: "packages/outbox",
  },
  {
    action: "heap_snapshot.written",
    level: "info",
    description:
      "A V8 heap snapshot was written — `event.reason`: signal (SIGUSR2), oom (near the heap " +
      "limit), manual (POST /debug/heapdump), uncaught (with a crash report).",
    fields: ["event.reason", "file.path"],
    source: "packages/observability",
  },
  {
    action: "diagnostic_report.written",
    level: "info",
    description:
      "A Node diagnostic report was written — `event.reason`: uncaught (the process is " +
      "crashing) or manual (POST /debug/report).",
    fields: ["event.reason", "file.path"],
    source: "packages/observability",
  },
];

/** The list as --log-events-reference prints it. */
export function logEventsReference(): string {
  return LOG_EVENTS.map((e) => {
    const fields = e.fields.length === 0 ? "" : `\n    fields: ${e.fields.join(", ")}`;
    return `${e.action}  ${e.level}  (${e.source})\n    ${e.description}${fields}`;
  }).join("\n\n");
}
