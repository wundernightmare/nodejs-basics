# @base/observability

OpenTelemetry SDK setup, Node/HTTP/DB metrics, heap-snapshot + crash-report
services and the **admin server** — the operational surface every service gets
for free on `ADMIN_PORT` (default 9090), separate from the API port.

The admin server is the Node counterpart of `libs/httpx` in golang-basics: same
routes, same auth model, same runtime-debugging tools, same problem+json errors.

## Admin server endpoints

| Route                      | Auth | Purpose                                                                                  |
| -------------------------- | ---- | ---------------------------------------------------------------------------------------- |
| `GET /livez`, `GET /healthz` | –  | Liveness — `200 {"status":"ok"}` while the process runs                                  |
| `GET /readyz`              | –    | Readiness — `200 {"status":"ok"\|"degraded"}` / `503 {"status":"not_ready"}` + per-check breakdown |
| `GET /metrics`             | –    | Prometheus exposition (OTel PrometheusExporter)                                          |
| `GET /version`             | –    | `{service, version, revision, node, started_at, uptime_seconds, env}` (`/admin/info` is an alias) |
| `GET /admin/config`        | –    | The effective configuration (`configSnapshot` from `@base/config`), secrets redacted     |
| `GET /admin/log-level`     | –    | `{level, base, expires_at, max_ttl}` — what is in effect and when it reverts             |
| `PUT /admin/log-level`     | bearer | `?level=trace\|debug\|info\|warn\|error\|fatal\|silent&ttl=30m` (or JSON `{level, ttl}`) — change the level for a while |
| `DELETE /admin/log-level`  | bearer | Revert to the configured level now                                                     |
| `POST /debug/heapdump`     | bearer | Capture a V8 heap snapshot (`enableHeapSnapshot`)                                      |
| `POST /debug/report`       | bearer | Node diagnostic report + heap snapshot (`enableCrashReport`)                           |

Nothing on this listener goes through the API's access log, request metrics or
tracing, so probes and scrapes never show up as traffic. **Keep it off the
ingress** — it is the listener that exposes internals.

**bearer**: the mutations require `Authorization: Bearer <ADMIN_TOKEN>` when
`ADMIN_TOKEN` is set (constant-time compare; `401 application/problem+json`
with `WWW-Authenticate: Bearer realm="admin"` otherwise, logged at warn). An
empty token leaves them open — the laptop / compose default — and the
"Admin server listening" log line says `auth=off` so it is never a surprise in
a cluster. Reads and probes never need a token.

**Errors** are RFC 9457 `application/problem+json` everywhere on this listener:
`404` for an unknown route, `405` (+ `Allow`) for a known route with the wrong
method, `400` for a bad level/ttl. Every response echoes `X-Request-Id`
(honoured from the client when it is 1–128 printable ASCII chars, generated
otherwise) and every problem body carries it as `request_id`.

## Runtime debugging

Three tools for "what is this pod doing", none of which needs a redeploy or a
new dependency:

**Log level for a while.** Every change made through the admin server expires
— `ttl` defaults to and is capped at `LOG_LEVEL_MAX_TTL` (24h) — so a debug
level nobody remembered to turn off cannot fill a disk. The change, the reset
and the TTL revert are logged at warn regardless of the level in effect, with
`log.level.from` / `log.level.to` / `client.address`.

```sh
curl -X PUT 'localhost:9090/admin/log-level?level=debug&ttl=30m' \
     -H "Authorization: Bearer $ADMIN_TOKEN"
# {"level":"debug","base":"info","expires_at":"…","max_ttl":"24h","previous":"info"}
curl -X DELETE localhost:9090/admin/log-level -H "Authorization: Bearer $ADMIN_TOKEN"
```

In code the same handle is `logLevel` from `@base/logger` (`logLevel.set("debug", ms)`,
`logLevel.reset()`); its state machine (`LogLevel`) has a generation counter so a
stale timer never reverts a newer change.

**Debug logging for one request.** With `DEBUG_TOKEN` set, an API request that
carries it in `X-Debug-Token` runs with every log line passing — whatever the
level — and the response carries `X-Debug-Logging: on`. Nothing else changes,
for anyone. A wrong or missing token is ignored silently (the API port is
public; it must not become an oracle). The same switch is
`withDebugLogging(fn)` from `@base/logger` for a worker that wants to debug one
message — `apps/worker` turns it on for a Kafka record carrying an
`x-debug-logging` header.

```sh
curl -H "X-Debug-Token: $DEBUG_TOKEN" -i localhost:3000/tasks
```

How it works: pino decides per level *method* (a disabled level is a no-op),
so the root logger is pinned at `trace` and a `logMethod` hook does the real
check — `logLevel.enabled(level) || isDebugLogging()`. Every child logger
(`AppLogger.child()`, Fastify's `req.log`) inherits the hook, so the switch
applies everywhere without wrapping.

**The effective config.** `GET /admin/config` shows what the process is
actually running with — every `ENV_REGISTRY` key after YAML, env and defaults,
with its provenance — through `redact()` from `@base/logger`: any key that looks
like a secret (password, secret, token, api key, private key, credential) becomes
`[redacted]` (an empty value stays empty, so "unset" is visible) and the
password of any URL with userinfo becomes `xxxxx`.

```json
{
  "config": { "DATABASE_URL": "postgresql://app:xxxxx@localhost:5432/app", "ADMIN_TOKEN": "[redacted]", "PORT": "3000" },
  "sources": { "DATABASE_URL": "default", "ADMIN_TOKEN": "env", "PORT": "yaml" }
}
```

**Correlation without tracing.** Tracing is opt-in and sampled; the request id
is neither. Every API response carries `X-Request-Id`, every log line of the
request carries it as `http.request.id`, every `problem+json` body carries it as
`request_id`, and the API forwards it as a Kafka record header so the worker's
log lines for that event correlate too.

## Readiness

`ReadinessService` aggregates named checks for `/readyz`. A check is **critical**
by default — failing turns readiness to `503 not_ready`; mark it `optional: true`
and a failure only reports `200 degraded` (a cache you can bypass, an event bus
you publish to best-effort). Provide checks with the module or register them
from the service that owns the dependency (the module is global):

```ts
ObservabilityModule.forRoot({
  telemetry,
  configSnapshot,                                   // GET /admin/config
  readinessChecks: { provide: READINESS_CHECKS, inject: [PG_POOL], useFactory: … },
});

// or, inside any provider:
constructor(readiness: ReadinessService) {
  readiness.register({ name: "kafka", check: async () => { consumer.assignment(); return "ok"; } });
}
```

### Graceful shutdown order

`app.enableShutdownHooks()` + SIGTERM → `app.close()`, which NestJS runs as:

1. `beforeApplicationShutdown` — `ReadinessService` closes the gate: `/readyz`
   answers `503 not_ready` so the load balancer stops routing;
2. `dispose()` — Nest closes the API listener (in-flight requests drain);
3. `onApplicationShutdown` — `AdminServerService` closes the admin listener last,
   so probes keep answering while the API drains.

The same order as `httpx.Server.Run` in golang-basics (`SetReady(false)` → API →
admin).

## Configuration

| Variable            | Default | Meaning                                                              |
| ------------------- | ------- | -------------------------------------------------------------------- |
| `ADMIN_PORT`        | `9090`  | Admin listener port                                                  |
| `ADMIN_TOKEN`       | *(empty)* | Bearer token for the mutations; empty = open (`auth=off`)          |
| `DEBUG_TOKEN`       | *(empty)* | `X-Debug-Token` value for per-request debug logging; empty = off   |
| `LOG_LEVEL_MAX_TTL` | `24h`   | Cap (and default) for a runtime log-level change                     |
| `GIT_COMMIT`        | *(empty)* | `revision` in `/version`                                           |

See `packages/config/src/env.registry.ts` for the full registry.
