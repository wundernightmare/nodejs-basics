# Production checklist

What a service built from this repo gets, rule by rule, where it lives and
which test proves it. "Opt-in" means the capability is there and off by
default; the key that turns it on is named. The same list, for the Go
sibling, is golang-basics' `docs/PRODUCTION-CHECKLIST.md`; where the two
runtimes differ the row says how.

## Runtime

| Rule | Where | Proof |
| --- | --- | --- |
| The V8 heap limit is checked against the container's memory limit at start; a heap that does not fit is reported with the `--max-old-space-size` to use (Node cannot change it while running) | `packages/observability/src/runtime-memory.ts` (`RUNTIME_HEAP_LIMIT_RATIO`), gauge `nodejs_container_memory_limit_bytes` | `runtime-memory.spec.ts` |
| CPU profile on demand, behind the token, on the internal port | `packages/observability/src/cpu-profile.ts` (`POST /debug/cpu-profile`) | `cpu-profile.spec.ts`, `admin-server.service.spec.ts` |
| Heap snapshot when it matters — near the heap limit, on SIGUSR2, on demand — and a diagnostic report of a process that died; both shipped to object storage when a bucket is set | `heap-snapshot.service.ts` (`HEAP_OOM_THRESHOLD`, `HEAP_SNAPSHOT_S3_BUCKET`), `crash-report.service.ts`, [DIAGNOSTICS.md](DIAGNOSTICS.md) | `heap-snapshot.service.spec.ts` |
| Continuous profiling — **opt-in** `PYROSCOPE_SERVER_ADDRESS` | `packages/observability/src/setup-telemetry.ts` (push SDK: Node has no scrape-able pprof endpoint) | — |
| Runtime metrics: event-loop delay, heap, GC, handles | `packages/observability/src/node-metrics.ts` | `node-metrics.spec.ts` |
| Nothing left running: every test file must leave no handle that keeps the process alive | `packages/testing/src/leaks.setup.ts` | every suite; `leaks.spec.ts` |

Not here: a flight recorder (a Go runtime facility) and a FIPS build mode —
`/version` reports `fips` (`crypto.getFips()`), the image does not enable it.

## Transport and resilience

| Rule | Where | Proof |
| --- | --- | --- |
| Graceful shutdown: SIGTERM → readiness off → a delay for the load balancer → drain → connections closed, admin listener last | `packages/observability/src/readiness.service.ts` (`HTTP_SHUTDOWN_DELAY_MS`), `apps/api/src/app.ts` | `readiness.service.spec.ts`; the e2e harness stops every service with SIGTERM (`e2e/fixtures/services.ts`) |
| A request has a budget, and every outbound call takes what is left of it | `packages/common/src/utils/deadline.ts` (`HTTP_REQUEST_TIMEOUT_MS`), `pg-deadline.ts`, `valkey-deadline.ts`, the HTTP and gRPC clients | `deadline.spec.ts`, `pg-deadline.integration.spec.ts` |
| Outbound HTTP: per-attempt timeout that covers making the connection, retries of what may be sent twice, backoff with jitter, `Retry-After`, retry budget, circuit breaker | `packages/resilient-client` | `resilient-client.guarantees.spec.ts`; real servers and Toxiproxy: `resilient-client.integration.spec.ts` |
| Outbound gRPC: deadline, retries, wait-for-ready, keepalive, circuit breaker per target | `packages/grpc-client` | `grpc-clients.spec.ts`; real servers and Toxiproxy: `grpc-clients.integration.spec.ts` |
| Inbound rate limit: token bucket, global and per client — **opt-in** `HTTP_RATE_LIMIT`, `HTTP_RATE_LIMIT_PER_CLIENT` | `packages/observability/src/http-rate-limit.ts` | `http-rate-limit.spec.ts` |
| Request body limit → 413 problem | `apps/api/src/app.ts` (`HTTP_BODY_LIMIT_BYTES`) | the contract declares 413 (`api/openapi3/tasks.openapi.yaml`) and `scripts/schemathesis.sh` checks the server against it — no test of its own |
| A Kafka handler attempt has a deadline; a failing message is retried with backoff, then parked on a dead-letter topic; a stop is bounded | `packages/kafka/src/kafka-consumer.ts` (`KAFKA_CONSUMER_HANDLER_TIMEOUT_MS`, `_MAX_RETRIES`, `_DRAIN_TIMEOUT_MS`) | `kafka-consumer.spec.ts`, `kafka-consumer.integration.spec.ts`, `kafka-chaos.integration.spec.ts` |

## Observability and operations

| Rule | Where | Proof |
| --- | --- | --- |
| Operational endpoints on a separate port, token-guarded; without a token the service refuses to start on a public interface | `packages/observability/src/admin-server.service.ts`, `admin-auth.ts` (`ADMIN_PORT`, `ADMIN_TOKEN`) | `admin-server.service.spec.ts`, `admin-auth.spec.ts` |
| Liveness is not readiness; readiness has critical and optional checks | `packages/observability/src/readiness.service.ts` | `readiness.service.spec.ts`, `e2e/tests/health.spec.ts` |
| RED metrics in and out, runtime metrics, `build_info`; every metric is in one registry | `packages/observability/src/metrics.registry.ts`; the contract shared with the Go sibling: golang-basics `docs/METRICS.md` | `metrics.registry.spec.ts`, `dashboards.spec.ts` |
| Traces over OTLP, W3C propagation | `packages/observability/src/setup-telemetry.ts` (`OTEL_*`) | `pg-tracing.integration.spec.ts`, `e2e/tests/observability.spec.ts` |
| Tail-based sampling: errors, slow traces and debug subjects kept in full | the collector: `docker/otel-collector/config.yaml` | `tail-sampling.integration.spec.ts` (the real collector with that file) |
| Structured logs in ECS field names, with trace correlation; the envelope is a contract | `packages/logger/src/pino.config.ts`, `docs/log-envelope.schema.json` | `pino.config.spec.ts`, `e2e/tests/logs.spec.ts` |
| Private data masked in logs and in `/admin/config`; credentials typed so they cannot be printed | `packages/logger/src/redact.ts`, `packages/common/src/utils/secret.ts`, `secret: true` in `env.registry.ts` | `redact.spec.ts`, `redact.prop.spec.ts`, `secret.spec.ts` |
| Log level changed at runtime, with a TTL | `PUT /admin/log-level` (`packages/logger/src/log-level.ts`) | `log-level.spec.ts`, `admin-server.service.spec.ts` |
| Debug logs and a kept trace for one tenant / user, with a TTL | `PUT /admin/debug-subjects/{subject}`, `withDebugSubject` (`packages/logger/src/debug-subjects.ts`) | `debug-subjects.spec.ts` |
| Debug logs for one request | `X-Debug-Token` (`packages/common/src/http/request-context.hooks.ts`) | `request-context.hooks.spec.ts` |
| An error nothing caught: handlers answer a 500 problem with an `error.id`; a background task is counted, logged and stops the process in order; the process itself writes a diagnostic report before it exits | `apps/api/src/http/problem-fallback.filter.ts`, `packages/logger/src/background-guard.ts`, `crash-report.service.ts` | `problem-fallback.filter.spec.ts`, `background-guard.spec.ts` |
| Minimal container: multi-stage, distroless, non-root | `apps/*/Dockerfile` | CI `hadolint`, image scan in `docker.yml` |

## Data and configuration

| Rule | Where | Proof |
| --- | --- | --- |
| Config validated at start, fail fast, every problem at once; unknown YAML keys are errors; `--check-config`, `--config-reference` | `packages/config/src/config.loader.ts`, `config.boot.ts`, `env.registry.ts` | `config.loader.spec.ts`, `config.boot.spec.ts`, `env.registry.spec.ts` |
| Connection pools sized explicitly, connections recycled by age | `packages/database/src/postgres-config.builder.ts` (`DATABASE_POOL_MAX`, `DATABASE_POOL_MAX_LIFETIME_MS`) | `pg-pool.provider.integration.spec.ts` |
| Server-side guard rails on every database session, read back on every new connection | `packages/database/src/pg-pool.provider.ts` (`DATABASE_STATEMENT_TIMEOUT_MS`, …, `PgGuardRailOffError`) | `pg-pool.provider.spec.ts`; behind PgBouncer: `pg-bouncer.integration.spec.ts` |
| A Valkey connection that went silent is dropped and replaced | `packages/cache/src/valkey-config.builder.ts` (`VALKEY_SOCKET_TIMEOUT_MS`) | `valkey-chaos.integration.spec.ts` |
| Schema changes are forward-only SQL files, checksummed, applied under a lock; risky DDL needs a review mark | `apps/migrate/src/migrate.ts` | `migrate.integration.spec.ts`, `migrate.pgbouncer.integration.spec.ts`, `migrations-safety.spec.ts` |
| A write and the event that announces it commit together | `packages/outbox` | `outbox.integration.spec.ts` |
| Version and revision baked into the image: start-up log, `build_info`, `/version` | `apps/*/Dockerfile` (`SERVICE_VERSION`, `GIT_COMMIT`), `admin-server.service.ts` | `admin-server.service.spec.ts` |

## Code quality and supply chain

| Rule | Where | Proof |
| --- | --- | --- |
| Linting and formatting with no warnings allowed, type-checked | `oxlint`, `oxfmt`, `tsc` (`pnpm check`) | CI `check`; pre-commit hook |
| Vulnerabilities: osv-scanner, grype; secrets: gitleaks; SAST: semgrep; Dockerfiles: hadolint | `.github/workflows/appsec.yml` | the jobs |
| Dependencies pinned: exact versions, a frozen lockfile, a release-age window, actions pinned by SHA; a waiver has a date | `pnpm-workspace.yaml`, `scripts/check-waivers.sh` | CI `sast` (waivers), `deps` |
| Real dependencies in tests, not mocks: Postgres, Valkey, Kafka, S3, Toxiproxy, PgBouncer, an OTel collector, a gRPC server, an HTTP edge | `packages/testing` (containers started by the test run) | CI `integration` |
| Property-based tests for parsers and pure logic | `*.prop.spec.ts` (fast-check) | CI `unit`; more runs in the nightly `fuzz` job |
| Mutation testing of decision logic | `stryker.config.mjs`: the HTTP and gRPC clients, `Secret`, the tier cache, the inbound rate limit | nightly `mutation` job |
| Coverage of the whole pyramid, merged; a change may not lower any package's | `scripts/cover.mjs`, `scripts/cover.config.mjs` | CI `coverage` |
| The API is its contract: the server is checked against the OpenAPI document | `api/`, `scripts/schemathesis.sh` | CI `contracts`, `schemathesis` |

## Deliberately not here

- **Authentication** (JWT, OAuth): project-specific. The hooks that need an
  identity (`withDebugSubject`, per-tenant limits) take one from the caller.
- **OTLP for metrics and logs**: metrics are Prometheus (scraped from the
  admin port), logs are stdout for whatever tails the container.
- **A gRPC server scaffold**: `grpc-client` is the outbound side.
- **A bulkhead, hedging, h2c and HTTP/3** in the HTTP client; **redirects**
  are returned to the caller, never followed.
