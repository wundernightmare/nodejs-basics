# @base/logger

Pino configured for ECS field names, OpenTelemetry trace correlation and the
AsyncLocalStorage request context, plus the NestJS `LoggerService` adapter and
the runtime log-level switch the admin server drives.

## Exports

| Export                      | What it is                                                                     |
| --------------------------- | ------------------------------------------------------------------------------ |
| `pinoLogger`                | The shared pino instance (pass to Fastify as `loggerInstance`)                 |
| `AppLogger`, `LoggerModule` | NestJS `LoggerService` over pino; `appLogger.child("Ctx")` for per-class loggers |
| `logLevel` / `LogLevel`     | Runtime level with TTL revert (`PUT /admin/log-level`)                         |
| `parseLogLevelStrict`, `parseDuration`, `formatDuration` | Strict parsers used by the admin server              |
| `redact`, `redactUrl`       | Operator-safe copy of a value (`GET /admin/config`)                            |
| `withDebugLogging`, `isDebugLogging`, `withRequestId`, `getRequestId`, … | Request-context switches, re-exported from `@base/common` |
| `ecsError`                  | `error.*` ECS fields for the merge object                                      |

Always use the merge-object form — never interpolate values into the message:

```ts
this.logger.info({ "user.id": userId }, "Invite sent");
```

`trace.id`, `span.id`, `http.request.id` are injected by
the mixin from the active span / ALS — don't pass them explicitly.

## Levels: base, runtime, per-request

- **Base level** — `LOG_LEVEL` (default `info` in production, `debug` elsewhere).
  Parsed strictly at startup: a typo fails the boot instead of silently
  logging at info.
- **Runtime level** — `logLevel.set(level, ttlMs)` switches the level for a
  while; when the TTL (capped at `LOG_LEVEL_MAX_TTL`, default 24h) runs out it
  reverts to the base level. `logLevel.reset()` reverts now. A generation
  counter makes a stale timer harmless. The admin server exposes this as
  `GET|PUT|DELETE /admin/log-level`; the revert is logged at warn.
- **Per-request debug** — `withDebugLogging(fn)` marks the async context so
  every log line inside passes whatever the level. The API sets it for a
  request carrying a valid `X-Debug-Token`; the worker sets it for a Kafka record
  with an `x-debug-logging` header.

### How the level is enforced

pino decides per level *method*: when the level is `info`, `logger.debug` is a
no-op function, so nothing downstream (mixin, hooks) ever runs for it. To let one
request bypass the level, the root logger is pinned at `trace` and the decision
happens in the `logMethod` hook:

```ts
hooks: { logMethod(args, method, level) {
  if (logLevel.enabled(level) || isDebugLogging()) method.apply(this, args);
} }
```

Every child (`AppLogger.child()`, Fastify's `req.log`) inherits the hook, so
the switch applies everywhere without wrapping. Consequences: never set
`pinoLogger.level` yourself (use `logLevel`), and `pinoLogger.isLevelEnabled()`
is not meaningful — ask `logLevel.enabled(value)`.

## redact()

```ts
redact({ DATABASE_URL: "postgres://app:s3cret@h", ADMIN_TOKEN: "t", COOKIE_SECRET: "", PORT: 3000 });
// → { DATABASE_URL: "postgres://app:xxxxx@h", ADMIN_TOKEN: "[redacted]", COOKIE_SECRET: "", PORT: 3000 }
```

Keys matching `password|passwd|secret|token|api[_-]?key|private[_-]?key|credential`
(case-insensitive) redact their whole subtree; empty strings stay empty; URL
passwords become `xxxxx`; numbers, booleans, null and dates pass through.

## Tests

`src/*.spec.ts` (vitest): `LogLevel` with fake timers (TTL revert, generation
counter, max-TTL cap, strict parsing, duration parser), `redact`, and the pino
hook (runtime level, debug flag on children, request id via the mixin).
