# nodejs-basics

A cloneable NestJS + Fastify monorepo template — production-shaped scaffolding
for any new service. Bring your own domain.

## What's in the box

```
apps/
  api/                   Reference NestJS app wiring everything together. Publishes
                         a task.created event to Kafka on write. (+ distroless Dockerfile)
  worker/                Kafka consumer worker: drains tasks.events, enqueues a
                         BullMQ job, processes it. (+ distroless Dockerfile)

e2e/                     Playwright API e2e (health, tasks CRUD, Kafka→BullMQ flow).
benchmarks/              k6 load test for the tasks API.

packages/
  resilient-client       undici + opossum + bottleneck HTTP client.
  config                 YAML config loader + env registry + secret-file watcher.
  logger                 Pino with ECS schema, OTel trace correlation, ALS context.
  common                 Request-context (ALS), nanoid, problem-details, UoW port,
                         RFC 9457 exception filters.
  resilience             Circuit breaker, retry policy with jittered backoff,
                         per-tenant DB rate limiter.
  database               pg.Pool with TLS, multi-host failover, secret-file
                         password rotation, circuit breaker, AsyncLocalStorage
                         transaction context. (No ORM — bring your own.)
  cache                  Valkey/Redis client with config builder shared with
                         BullMQ, OTel client metrics.
  kafka                  Confluent Kafka producer + librdkafka SASL/TLS config
                         builder + OTel client metrics.
  jobs                   BullMQ NestJS module: configurable named queues,
                         OTel metrics, BullBoard wiring.
  idempotency            Idempotency-Key interceptor + decorator with pluggable
                         KV store (default: Valkey).
  observability          OpenTelemetry SDK setup, Node/HTTP/DB metrics,
                         admin server (/metrics, /livez, /readyz, /admin/*).
```

## Quick start

```sh
pnpm install
pnpm lefthook install              # one-time git hooks setup
just deps                          # postgres + valkey + redpanda
cp apps/api/config.example.yaml apps/api/config.yaml
just dev                           # apps/api on :3000, admin :9091 — rebuilds + restarts on every save
just dev-worker                    # apps/worker, admin :9093 (another terminal)
```

Then:

- `curl http://localhost:3000` — main API
- `curl http://localhost:9091/metrics` — Prometheus metrics
- `curl http://localhost:9091/readyz` — readiness probe
- `curl http://localhost:9091/version` — service, version, revision, start time / uptime (`/admin/info` is an alias)
- `curl http://localhost:9091/admin/config` — the effective config, secrets redacted
- `curl -X PUT -H "Authorization: Bearer $ADMIN_TOKEN" 'http://localhost:9091/admin/log-level?level=debug&ttl=30m'` — change
  log level live

The admin ports are the ones `just stack-up` publishes too (9091 api, 9093
worker; `ADMIN_PORT` overrides), so both apps run side by side, 9090 stays free
(Prometheus; Cockpit on Fedora), and Prometheus finds them either way.

Optional observability stack:

```sh
just obs                           # Jaeger :16686, Prometheus :9090, Grafana :3001
```

### The whole thing in containers (api + worker)

```sh
just stack-up                      # build + run deps + api + worker images
curl -XPOST localhost:3000/tasks -H 'content-type: application/json' -d '{"title":"hi"}'
curl -s localhost:9093/metrics | grep worker_tasks   # the worker drained the event
just stack-down
```

The distroless images build the whole pnpm workspace and ship it on
`gcr.io/distroless/nodejs24-debian13` (non-root). The native
`@confluentinc/kafka-javascript` addon links only libstdc++/glibc (librdkafka is
bundled), which the distroless base provides.

### Tests, e2e, load, security

```sh
just test                          # unit layer (vitest project `unit`)
just deps && just test-integration # integration layer against real Postgres / Valkey / Redpanda
just stack-up && just e2e          # Playwright API e2e against the production images
just cov-all                       # all three layers → one merged coverage number, gated
just allure-report                 # one HTML report from every layer's allure-results/
just bench-tasks smoke             # k6 load test (needs the stack up)
just setup-sec                     # one-time: install the AppSec toolchain (mise)
just sec                           # expired waivers + gitleaks + semgrep + osv-scanner + hadolint
just docker-build api              # build an image; docker-scan-ci api → grype --fail-on high
```

See [Tests](#tests) for the layers, the harness and the coverage / Allure flow,
[Contracts](#contracts) for the TypeSpec → OpenAPI → types pipeline.

## Build & watch

Packages are compiled by `tsc` (they ship `dist/` with declarations); the
apps are bundled by **Vite** — one ESM file per app, `apps/<app>/dist/main.js`
(+ source map), from [`vite.app.config.ts`](vite.app.config.ts):

- `@base/*` is bundled **from `src/`** (the `source` export condition, the
  same one vitest and the tests use), so an app build needs no package build
  and a watch picks up a change anywhere in the workspace. Every other bare
  import stays external — native addons and OpenTelemetry's module patching
  need the real modules on disk.
- Imports a bundled package makes (`@opentelemetry/api` from
  `@base/observability`, `pg` from `@base/database`, …) are resolved at build
  time from that package's own `node_modules` and emitted as paths relative to
  `dist/`: pnpm's strict layout would not let the app resolve them, and each
  package keeps declaring exactly what it imports. The resolution follows
  Node's (`node` / `import` / `default` conditions, `main` field), so a package
  imported both bare by the app and by path from a bundle is one module
  instance.
- NestJS needs legacy decorators with `emitDecoratorMetadata`; Vite's oxc
  transform does not emit it, so the transform is SWC (`unplugin-swc`). There
  is no Nest CLI.

```sh
pnpm build                         # every package (tsc) + every app (vite)
just dev                           # api: vite build --watch + restart after each build (scripts/dev.mjs)
just dev-worker                    # the same for the worker
just build-watch api               # rebuild only, no process
just test-watch                    # vitest, unit project — re-runs what a change touches
just test-watch-integration        # vitest, integration project (needs `just deps`)
```

`scripts/dev.mjs` restarts the app **after** Vite reports a successful build
(SIGTERM → the app's graceful shutdown → spawn), never on a file event, so a
half-written bundle is never started and a save with a syntax error keeps the
last good build running. `pnpm start:debug` passes `--inspect` to the app
process. The Docker images run the same bundle (`CMD ["dist/main.js"]`).

## Renaming `@base` to your org

```sh
# rg + sd are the fastest combo. Falls back to grep + sed.
sd '@base/' '@yourorg/' $(rg -l '@base/')
sd '"@base/' '"@yourorg/' $(rg -l '@base/')
sd '"name": "@base/' '"name": "@yourorg/' packages/*/package.json apps/*/package.json
pnpm install
```

Verify:

```sh
pnpm typecheck
pnpm lint
```

## Design notes

### Layering

```
apps/api  →  @base/* packages  →  third-party (NestJS, OTel, Fastify, ...)
```

`apps/api` is yours to edit; `packages/*` are framework code you'll occasionally
upgrade. The split matters because `apps/api/src/main.ts` and `app.module.ts`
are the only files that need bespoke wiring per project.

### Telemetry must be first

`apps/api/src/instrumentation.ts` calls `setupTelemetry()` and is imported as
the very first line of `main.ts`; its own first import (`service-name.ts`)
sets the app's default `OTEL_SERVICE_NAME` (`nodejs-basics-api` /
`nodejs-basics-worker`) before any module reads it. Don't move either. Which
instrumentations work in the bundle: see "How spans are made" below.

### Config priority

```
process.env  >  YAML structured (database.url)  >  YAML flat (DATABASE_URL)  >  defaults
```

Defined once in `packages/config/src/env.registry.ts`. Every config knob your
app reads must be added there — `env.registry.spec.ts` scans the runtime
sources and fails on a key read through `config.get`, a builder's reader or
`process.env` that is not registered (only a registered key has a YAML path and
shows up in `GET /admin/config`). The loader fails fast at startup if a
`required: true` entry is missing. Telemetry keys (`OTEL_*`, `SENTRY_DSN`,
`PYROSCOPE_SERVER_ADDRESS`) are environment-only: tracing starts before the
YAML file is read.

### Domain errors → HTTP

Subclass `DomainError` (`@base/common`) for every domain-level error your use
cases throw. Wire the class → status mapping in `apps/api/src/main.ts`'s
`ERROR_MAP`. The global filter formats every response as RFC 9457
`application/problem+json`. Never throw `HttpException` outside of HTTP
controllers/guards.

### Transactions

`@base/common` exposes `IUnitOfWork` and `UNIT_OF_WORK`. `@base/database`
exposes `transactionStorage` (an `AsyncLocalStorage<unknown>`). The pattern
your repositories should follow:

```ts
private withTx<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
  const tx = transactionStorage.getStore() as TxClient | undefined;
  if (tx) return fn(tx);
  return this.runMiniTx(fn);          // fallback if not inside a UoW
}

private db(): TxClient | DbClient {
  return (transactionStorage.getStore() as TxClient | undefined) ?? this.client;
}
```

A reference `IUnitOfWork` for Prisma:

```ts
@Injectable()
export class PrismaUnitOfWork implements IUnitOfWork {
  constructor(private readonly prisma: PrismaService) {}
  runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => transactionStorage.run(tx, fn));
  }
}
```

Wire in your AppModule:
```ts
{ provide: UNIT_OF_WORK, useClass: PrismaUnitOfWork }
```

### Hexagonal layout per domain (recommended)

```
modules/<domain>/
  domain/             entities, errors, repository ports, const enums
  application/        use cases (commands), query services (reads)
  infrastructure/     repository implementations, external service adapters
  http/               controllers, DTOs, route guards
```

- Use cases throw domain errors; the `DomainExceptionFilter` maps to HTTP.
- Reads (queries) bypass domain entities — go directly through your ORM
  with `JOIN`/`include`. No N+1.
- Writes (commands) wrap the entire read-then-write sequence in
  `runInTransaction()` to be TOCTOU-safe.
- External calls (email, third-party APIs) happen **after** the
  transaction commits — capture data inside the tx, fire side effects after.

### Idempotency

Decorate any mutating endpoint with `@Idempotent()` and clients can safely
retry by sending an `Idempotency-Key` header. The interceptor caches the
response in Valkey. Lock-on-conflict semantics prevent the same key from
being processed twice concurrently.

### Logging

Always use the merge-object form — never interpolate values into the message:

```ts
this.logger.info({ "user.id": userId, "tenant.id": tenantId }, "Invite sent");
```

`actor.id`, `tenant.id`, `trace.id`, `span.id` are auto-injected from ALS by
the pino mixin in `@base/logger`. Don't pass them explicitly.

## Patterns NOT included (build per project)

- **Auth (JWT, OAuth, MFA, PATs)** — strongly project-specific.
- **AuthZ (OPA, Casbin, role matrices)** — project-specific.
- **Tenant model** — your User/Tenant/Membership schema.
- **OpenAPI generation** — `@nestjs/swagger` + `nestjs-zod`'s `createZodDto`
  plug in cleanly; the example app omits this for simplicity.
- **Prisma / Drizzle / Kysely** — `@base/database` exposes `PG_POOL`. Hand it
  to your ORM's adapter and you're done. See README's "Transactions" for the
  UnitOfWork pattern.

## Local dependencies (`docker/deps.yml`)

| Service     | Image                           | Port |
|-------------|---------------------------------|------|
| Postgres 18 | `postgres:18`                   | 5432 |
| Valkey 9    | `valkey/valkey:9.0`             | 6379 |
| Redpanda    | `redpandadata/redpanda:v26.2.3` | 9092 |

Default credentials: `app` / `app` for postgres. **Change before deploying.**

## Observability stack (`docker/observability.yml`)

| Service        | Image                                          | Port  |
|----------------|------------------------------------------------|-------|
| Jaeger v2      | `jaegertracing/jaeger:2.21.0`                  | 16686 |
| Prometheus     | `prom/prometheus:v3.14.0`                      | 9090  |
| Grafana        | `grafana/grafana:12.4.11`                      | 3001  |
| OTel Collector | `otel/opentelemetry-collector-contrib:0.161.0` | 4317  |

Images are pulled through `${DOCKER_HUB}` (default `docker.io`, see
`.env.example`), like everything else in the repo.

Bring up only when you want traces/metrics locally. The apps export without
it — Prometheus is just unscraped, traces are dropped.

- **Metrics**: Prometheus scrapes the admin `/metrics` of the api (host 9091)
  and the worker (host 9093) — the same ports under `just dev` and
  `just stack-up`. Grafana opens on the provisioned `nodejs-basics` dashboard
  (`docker/grafana/dashboards/`): RED for the api (rate, 5xx / 4xx ratio,
  p50/p95/p99), worker throughput and backlog, event loop, heap, pg pool,
  Valkey.
- **Traces**: one trace per request, across both apps —
  `POST /tasks` → Valkey (idempotency) → Postgres (`BEGIN` / `INSERT` /
  `COMMIT`) → `send tasks.events` → worker `process tasks.events` →
  `send task-events` → `process task-events`. Every log line carries the
  `trace.id` of the span it was written in.

### How spans are made

The apps ship as one Vite bundle, and every module it imports is loaded
before `instrumentation.ts` runs — so OTel instrumentations that patch a
module when it is first loaded (`instrumentation-pg`, `-nestjs-core`,
`-aws-sdk`, `-ioredis`, …) never fire. What does work, and what the repo uses:

| Source | How |
|---|---|
| inbound HTTP | `@fastify/otel` plugin (`apps/api/src/instrumentation.ts`), span `{method} {route}` |
| outbound HTTP | `UndiciInstrumentation` (diagnostics_channel, no patching) |
| Postgres | `@base/database` `tracePgPool` — wraps the pool it builds |
| Valkey | `@base/cache` `traceValkeyClient` — wraps the shared client |
| Kafka | `@base/kafka` `KafkaProducerService.send` / `traceKafkaMessage` — `traceparent` in the record headers |
| BullMQ | `@base/jobs` `addTraced` / `traceJob` — context in the job's `opts.telemetry.metadata` |

DB / cache spans are only made under an active span (no root trace per
readiness probe); query text is the parameterised statement and Valkey
arguments are never recorded. Adding a client of your own: wrap it the same
way, or use an instrumentation that does not rely on patching. Tests assert on
spans with `captureSpans()` from `@base/testing`.

## Tests

Every test in the workspace is an Allure test, every layer feeds one merged
coverage number, and every behaviour is checked at exactly one layer — the
same contract as the Go sibling. The harness that makes that cheap is
[`packages/testing`](packages/testing) (`@base/testing`, test-only).

### Layers and what each one owns

| Layer | Where | Owns | Does not repeat |
|---|---|---|---|
| **Unit** | `*.spec.ts` next to the code — vitest project `unit`, `just test` | pure logic: config builders, backoff, the resilient client against a mock agent, redaction, the runtime log level, the admin router over an in-process `node:http` server | anything that needs a real dependency |
| **Property** | `*.prop.spec.ts` next to the code ([fast-check](https://fast-check.dev)) — part of `just test` (100 cases per property), `just fuzz` for the deep run (5000) | the invariants of the pure parsers and calculators over generated input, where a unit test says "for this one" and a property says "for all": the back-off never leaves its window, `redact()` lets no secret or URL password through and is idempotent, durations round-trip and reject everything else with the documented error, a request id is exactly 1–128 printable ASCII, `metricValue` reads back what an exporter writes, a problem body always carries its standard members | the example-based cases already in the unit spec |
| **Mutation** | `packages/resilient-client` — `just mutate` (StrykerJS, [`stryker.config.mjs`](stryker.config.mjs)), the nightly `mutation` CI job | whether the unit tests of the pure decision logic would notice a wrong comparison, operator or branch | — |
| **Integration** | `*.integration.spec.ts` — vitest project `integration`, `just test-integration` | the libs against real Postgres / Valkey / Redpanda from `docker/deps.yml`: the unit of work commits and rolls back as one, the Valkey option bag connects and BullMQ's blocking poll outlives the command timeout | route behaviour already proven with fakes; process-level behaviour |
| **E2E** | [`e2e/`](e2e) (Playwright, API tests) — `just e2e` (production images) / `just e2e-spawn` (built processes) | what only a real process shows: it boots, is ready on its admin listener, is a scrape target, and the cross-process flow api → Kafka → worker → BullMQ | per-route behaviour, error bodies (unit), the libs' semantics (integration) |
| **Smoke** | the `@smoke` titles in `e2e/` — `just e2e-smoke`, the `e2e-stack` CI job | the distroless images start and serve | everything else |
| **Contract** | `apps/api/src/app.contract.integration.spec.ts` (integration project; `createApp` + fastify `inject`, every exchange validated with `loadOpenAPI` from `@base/testing`) | the running app honours [`api/tsp`](api/tsp): every route, every declared status, problem bodies, 404/405 routing | inputs the schema can generate (generative) |
| **Generative** | `just schemathesis` (Schemathesis against the built api and its OpenAPI document) | inputs nobody wrote a test for: every operation with generated positive and negative requests and stateful sequences, no 5xx, every response in the contract's shape — "bad input → 4xx problem" cases are owned here, not hand-written | business semantics the schema cannot express (unit / contract), effects on dependencies (integration) |
| **Load** | [`benchmarks/`](benchmarks) (k6) | latency / error thresholds under load; reports on the load stand, outside Allure | — |

When you add a behaviour, put its test at the lowest layer that can observe
it, and only there. If a higher layer needs it as a precondition, it waits for
it (the e2e harness waits for `/readyz`), it does not assert it again.

### Harness: `@base/testing`

- `meta({ epic, feature, owner, tags })` at the top of a `describe` labels
  every test in it; `await testCase("NB-101", "story")` inside a test binds it
  to its TestOps case (Allure id, story, TMS link). Sample values — see
  [TestOps metadata](#testops-metadata).
- `integration("postgres", "valkey")` is the layer switch: it reads the same
  env the app reads (`DATABASE_URL`, `VALKEY_URL`, `KAFKA_BROKERS`), **skips**
  the suite locally when a service is unset (`describe.skipIf(infra.skip)`)
  and **fails** it when `CI` is set, so a pipeline can never go green by
  silently skipping the layer. No container orchestration in the test process,
  no extra dependency: `just deps` locally, the deps compose in CI. Suites
  isolate through `unique("prefix")` names, never a fresh service.
- `captureLogs()` (a real pino logger writing JSON into memory) and
  `metricValue(text, name, labels)` (a sample out of Prometheus text; `-1`
  when absent) let a test assert on telemetry instead of mocking it.
- `loadOpenAPI("openapi3/tasks.openapi.yaml").validate(method, path, status,
  body, headers)` throws unless the exchange is in the contract (operation
  matched by path template, status declared, content type declared, required
  headers present, body conforms — ajv, OpenAPI 3.0 `nullable` translated);
  `validateSchema("Problem", body)` checks a body against a named component.
  The Node twin of the Go sibling's `testx.LoadOpenAPI`.

Specs import `describe` / `it` / `expect` from `vitest` explicitly (no
globals). The root [`vitest.config.ts`](vitest.config.ts) is the one config:
two projects, `resolve.conditions: ["source"]` so `@base/*` resolves to
`src/` without a build, allure-vitest for every run.

### Allure

vitest (allure-vitest) and Playwright (allure-playwright) write to
`allure-results/`, or to `ALLURE_RESULTS_DIR` — CI points every job at one
directory and publishes the raw results (for an Allure server / TestOps) plus a
single-file HTML report (`allure-report` job; locally `just allure-report`,
`allure-commandline` from the root `package.json`, JRE pinned in `mise.toml`).
`scripts/allure-meta.sh` adds [`allure/categories.json`](allure/categories.json)
(how failures are bucketed: product defect / test defect / infrastructure /
flaky / skipped) and an `executor.json` (which CI run, linked) before the
report is generated. Tags name the package and the layer (`cache`,
`integration`, `e2e`), so the report can be sliced by either.

### TestOps metadata

Every suite carries an epic / feature / owner, every test an id and a story;
the id becomes a TMS link through the `links.tms.urlTemplate` in the vitest
and Playwright configs. The values in this repo are **samples** —
`nodejs-basics`, `@team-platform`, `NB-<n>`, `*.example.internal` — whose
shape is the point; replace them with your TestOps tree. One rule survives
the replacement: an id appears in exactly one test, and a test without an id
is not in the test plan.

### Coverage: one number, three layers

[`scripts/cover.mjs`](scripts/cover.mjs) collects each layer as an istanbul
`coverage-final.json`: vitest writes it directly (v8 provider), and for the e2e
layer the harness spawns the built api + worker under `NODE_V8_COVERAGE`
(`E2E_SPAWN=1`), waits for them to exit on SIGTERM (that is when Node flushes
the counters) and `scripts/v8-to-istanbul.mjs` (ast-v8-to-istanbul, the
converter vitest itself uses) maps the bundles' raw V8 ranges back to `src/**`
through their source maps — c8 was tried first and silently dropped every
*uncovered* range of a bundle. `merge` unions the layers **per line**: the
executable lines of every file are what vitest reports (it lists every
included file, covered or not; the e2e layer only contributes hits), and a
line is covered when any layer hit it. Nothing is counted twice; it writes
`coverage-merged.lcov` + a per-package `coverage-breakdown.json`, and gates on
[`scripts/cover.config.mjs`](scripts/cover.config.mjs). `just cov-check`
gates whatever is under `.cover/`; `just cov-all` is the only entry point that
guarantees all three layers. Both pipelines do the same: the test jobs upload
`.cover/<layer>`, the `coverage` job merges, gates and prints the per-layer and
merged totals.

Two gates, both on the merged profile: the absolute total (and per-package
overrides) in `cover.config.mjs`, and **no regression** — the `coverage` job
keeps master's per-package breakdown (a cache on GitHub, the master pipeline's
artifact on GitLab) and a pull request is compared to it with
`--diff-threshold 0`. Old code's coverage cannot pay for new code's. The
thresholds are a ratchet: raise them when coverage improves, lower only with a
reason in the commit.

### Contracts

The HTTP API is written once, in [TypeSpec](https://typespec.io) under
[`api/tsp`](api/tsp) (TypeSpec 1.15, OpenAPI 3.0 output — the same toolchain
as the Go sibling), and everything else is generated from it:

```
api/tsp/*.tsp ─tsp compile─▶ api/openapi3/tasks.openapi.yaml ─openapi-typescript─▶ packages/contracts/src/tasksapi.gen.ts  (@base/contracts)
```

`just contracts` (`pnpm contracts`) regenerates both; the outputs are
committed, so a reviewer sees the contract diff next to the code diff.
`just contracts-check` (the `contracts` CI job) fails when the committed
outputs are stale and, on a pull request, when `oasdiff` finds a breaking
change against master's OpenAPI document. A change that is breaking by the
rules but safe in practice is waived in
[`api/oasdiff-breaking.ignore`](api/oasdiff-breaking.ignore), one line per
change with the reason and the removal trigger — the same discipline as the
CVE waivers.

The document says what is true of the app, member for member: every object is
closed (`seal-object-schemas` — the zod DTOs are `.strict()`), text carries
the `^[^\u0000]*$` pattern (PostgreSQL TEXT rejects a NUL byte; lengths count
code points, as JSON Schema does), ids are 21-character nanoids,
`Idempotency-Key` is a UUID, and every error — validation, domain, routing
(404 unknown path, 405 undeclared method with `Allow`), the unplanned 500 — is
an RFC 9457 `Problem` with `errorId`, `instance` and `request_id`. The
generated types are the wire types for a client; the app's own request DTOs
stay zod (runtime validation), mirrored on the contract and held to it by the
two layers below.

Tests enforce it: the contract layer
([`apps/api/src/app.contract.integration.spec.ts`](apps/api/src/app.contract.integration.spec.ts))
boots the real app (`createApp` in `apps/api/src/app.ts`, the wiring
`main.ts` listens with) against the real deps, drives it with fastify
`inject` and validates every exchange with `loadOpenAPI(...).validate`; the
generative layer (below) does the same with requests it derives from the
document. A handler that drifts from the contract fails its own test.

### Schemathesis

[Schemathesis](https://schemathesis.io) is the generative layer: it reads the
OpenAPI document and drives the *real process* (`apps/api/dist`, scratch ports
18300/19300) with requests it derives from the schema — boundary values,
invalid bodies, unknown members, undeclared methods, stateful
create → read → update → archive chains over the links it infers — checking
that nothing answers 5xx, that valid data is accepted and invalid data
rejected, and that every response's status, headers and body are in the
contract.

```sh
just deps && just schemathesis          # SKIP_BUILD=1 reuses dist/, SCHEMATHESIS_MAX_EXAMPLES=… tunes depth
```

It runs from its pinned image (`SCHEMATHESIS_VERSION` in `mise.toml`,
`DOCKER_HUB` for a closed network; the script adapts to rootless podman and
SELinux hosts), reports natively to Allure next to every other layer, and is a
job in both pipelines (`schemathesis`, in the gate). Its first run found that
an undeclared method got a 404 instead of a 405, that `POST /tasks/{id}/archive`
answered 201 (NestJS's POST default) for a document that says 200, that an
over-long id was a 414, that the bodies were strict while the document was
open, that unknown query parameters were silently ignored, and that a reused
`Idempotency-Key` replayed the first 201 for *any* payload (even none) — the
interceptor now binds the key to a request fingerprint and answers a
different request under the same key with a 409 problem. The app and the
document agree on all of it. With it in place, hand-written
"bad input → 4xx" tests are not needed — the schema and the generator own
that class of case.

One warning is expected and harmless: "schema validation mismatch" for
`PATCH /tasks/{id}` and `POST /tasks/{id}/archive`. In the fuzzing phase their
positive cases carry random well-formed ids (404) and their negative cases
malformed bodies (400) — a ratio the heuristic reads as "mostly rejected"; the
stateful phase, which reaches real ids through the links it infers, passes
every scenario.

### Property-based testing

Everything that parses or computes from input it does not control has a
property spec next to it — `*.prop.spec.ts`, [fast-check](https://fast-check.dev):
`computeJitteredDelay` (`@base/resilient-client`), `redact` / `redactUrl` and
`parseDuration` / `formatDuration` (`@base/logger`), `isValidRequestId` and
`problemDetail` (`@base/common`), `metricValue` (`@base/testing`). They are
unit tests: `pnpm test` runs each property with 100 generated cases
(`propertyRuns()` in `@base/testing`); `just fuzz` / `pnpm fuzz` is the deep
run with `FC_NUM_RUNS=5000` — the Node analogue of the Go sibling's
`just fuzz` / `FUZZTIME` — and the nightly `fuzz` CI job. A failing property
prints its shrunk counterexample and seed (`{ seed, path }`); pin the
counterexample as an `examples:` entry of that property so it stays a
regression case, the way the Go sibling commits `testdata/fuzz/` corpora. The
first run found four: `computeJitteredDelay` returned `NaN` for
`minTimeout: 0` once `factor^attempt` overflowed (0 · ∞); `parseDuration`
accepted a number too long for a double as `Infinity` and returned `0` for
`"0.0001"`; `redact()` turned an own `"__proto__"` key (what `JSON.parse`
produces) into the copy's prototype and dropped it; `metricValue` could not
read a label value containing `}` (a route template) or an escaped newline.
All fixed; each spec carries the case.

### Mutation testing

Coverage says a line ran; mutation testing says a test would notice if it
were wrong. [StrykerJS](https://stryker-mutator.io) mutates the code (flips a
comparison, an operator, a branch, empties a literal), re-runs the specs that
cover the mutated line (`coverageAnalysis: perTest`) and reports every mutant
that *survived*. It is worth its cost on small, pure, decision-heavy code and
noise elsewhere, so — like the Go sibling — it is scoped, not global:
[`stryker.config.mjs`](stryker.config.mjs) mutates `packages/resilient-client`
only (backoff, cache, errors, pool, the client; not the OTel wiring).

```sh
just mutate          # pnpm mutate → reports/mutation/mutation.html (+ mutation.json)
```

Score when introduced: 56.8 % (backoff 95, cache 86, errors 88, pool 39,
client 56). `thresholds.break` (50) is a ratchet like the coverage gate: the
run fails below it; raise it as survivors are triaged — a survivor is a
missing assertion or dead code — lower it only with a reason in the commit.
Two things make it run in this workspace: Stryker works **in place**
(`inPlace: true`, the tree is restored on exit, backup under `.stryker-tmp/`)
because pnpm's `node_modules` symlinks and the `source` export condition do
not survive a sandbox copy — so never run it alongside a formatter or another
vitest run; and the root `vitest.config.ts` drops Allure and the integration
project when `STRYKER_MUTATOR_WORKER` is set. CI runs it nightly and on
demand (`mutation` job), never per PR: 20 s on a 32-core box, minutes on a
2-core runner.

### Flakiness policy

No retries anywhere (`retries: 0` in Playwright, `retry: 0` in vitest). A
test that fails once in a while is reported by Allure as what it is; mark it
flaky with a ticket, fix it, or delete it — never hide it behind a re-run.

## Security tooling

AppSec tools are pinned in `mise.toml` and installed by `just setup-sec`; every
`just sec-*` recipe runs its tool through `mise exec --`, and CI runs the same
versions from pinned container images (see "Pipelines" below).

| Recipe             | Tool        | Config             | Covers                                        |
|--------------------|-------------|--------------------|-----------------------------------------------|
| `just sec-waivers` | sh + awk    | —                  | no `Remove after YYYY-MM-DD` date has passed  |
| `just sec-secrets` | gitleaks    | `.gitleaks.toml`   | secrets in tree + history                     |
| `just sec-sast`    | semgrep     | `.semgrepignore`   | `p/owasp-top-ten` + `p/typescript` packs      |
| `just sec-deps`    | osv-scanner | `osv-scanner.toml` | OSV.dev advisories over `pnpm-lock.yaml`      |
| `just sec-iac`     | hadolint    | `.hadolint.yaml`   | every `apps/*/Dockerfile`                     |
| `just sec`         | —           | —                  | all of the above, fail-fast                   |

Container side (against a locally-built image):

```sh
just docker-build api         # build nodejs-basics-api:dev
just docker-scan api          # syft SBOM (sbom-api.json) + grype CVE scan
just docker-scan-ci api       # same, --fail-on high (the CI gate)
just docker-sign api dev      # cosign sign (key-mode, no Rekor; COSIGN_PRIVATE_KEY from .env)
just docker-verify api dev    # offline verify against cosign.pub
```

CI builds every `apps/*/Dockerfile`, generates the SBOM (kept 7 days as a job
artifact) and fails on HIGH+; it does not push or sign — that stays a local /
release-time step.

### pnpm supply-chain policy (`pnpm-workspace.yaml`)

| Setting                    | Effect                                                                                  |
|----------------------------|-----------------------------------------------------------------------------------------|
| `minimumReleaseAge: 10080` | a version published < 7 days ago does not resolve (`.npmrc` `min-release-age=7` for npm) |
| `blockExoticSubdeps`       | transitive deps come from the registry only — no git / tarball URLs                     |
| `trustPolicy: no-downgrade`| a dependency update cannot silently relax these settings                                |
| `allowBuilds`              | the only postinstall scripts allowed to run (pnpm 11+ fails the install otherwise)      |
| `overrides`                | caret floors: CVE fixes on transitive deps + one copy of cross-package types            |
| `peerDependencyRules`      | peers declared older than what we run (Sentry / nestjs-zod vs NestJS 12), checked to work |
| `minimumReleaseAgeExclude` | the escape hatch — time-boxed, with a `Remove after YYYY-MM-DD` line                    |

Waivers that cannot be pinned out go in `osv-scanner.toml` / `.grype.yaml`,
each with the reason and a removal trigger. A dated trigger is written
`Remove after YYYY-MM-DD` anywhere in the repo, and `scripts/check-waivers.sh`
(`just sec-waivers`, part of `just sec`; the CI `sast` job) fails once the date
has passed (`TODAY=2026-12-01 scripts/check-waivers.sh` previews). Both the
appsec workflow (nightly) and the docker workflow (weekly, base images
re-pulled) also run on a schedule — advisories and expiry dates do not need a
commit to arrive.

### Pipelines

`.github/workflows/{appsec,docker}.yml` and the `security` / `docker` stages of
`.gitlab-ci.yml` are kept at parity, and the pipeline itself is part of the
attack surface — the `sast` job scans it too. Rules worth knowing before they
block a change:

- **nothing hard-codes a tool version**: both pipelines start with a `versions`
  job that runs `scripts/mise-pins.sh` (pins out of `mise.toml`, pnpm out of
  `package.json`); GitHub consumes them as job outputs, GitLab as a `dotenv`
  artifact used even inside `image:` (`extends: .pins`);
- **scanners run from version-pinned images** on both sides (gitleaks, semgrep,
  osv-scanner, hadolint, syft, grype) — no marketplace action with its own
  bundled binary, no `curl | sh`, no `:latest`;
- **every `uses:` is pinned to a full commit SHA** with the version as a comment
  (`actions/checkout@3d3c42e5… # v7.0.1`) — a tag can be repointed by the
  action owner; `.github/dependabot.yml` keeps the SHAs current (weekly, 7-day
  cooldown, one grouped PR);
- **`github.*` context never appears inside `run:` text** — it goes through
  `env:` and the script expands the variable (an attacker-controlled branch
  name or PR title in a script is shell injection);
- **`semgrep scan --metrics=off`, never `semgrep ci`**;
- **every upstream host is a variable with the public default**, so a closed
  network sets `DOCKER_HUB` / `GHCR` / `GCR`, `GRYPE_DB_UPDATE_URL`,
  `OSV_SCANNER_FLAGS`, `SEMGREP_CONFIG`, `npm_config_registry` /
  `COREPACK_NPM_REGISTRY` as CI variables (GitLab group/project variables,
  GitHub `vars.*`) and locally in `.env` — [`.env.example`](.env.example)
  documents every knob; `just` (`set dotenv-load`) and mise (`[env] _.file`)
  both load it.

## Scripts

| Command            | What it does                            |
|--------------------|-----------------------------------------|
| `pnpm typecheck`   | tsc --noEmit per package (TypeScript 7, native) |
| `pnpm lint`        | oxlint                                  |
| `pnpm format`      | oxfmt                                   |
| `pnpm test`        | unit layer (vitest project `unit`)      |
| `pnpm test:integration` | integration layer (needs `just deps`) |
| `just contracts` | regenerate `api/openapi3` + `@base/contracts` from `api/tsp` |
| `just contracts-check [BASE]` | generated files current + oasdiff breaking-change gate |
| `just schemathesis` | generative layer against the built api (needs `just deps`) |
| `just cov-all` / `cov-check` | three-layer coverage, merged + gated |
| `just fuzz` / `mutate` | property specs with 5000 cases / StrykerJS on resilient-client |
| `just allure-report` | one Allure HTML report from every layer |
| `just e2e` / `e2e-smoke` / `e2e-spawn` | Playwright vs images / @smoke / spawned processes |
| `pnpm check`       | typecheck + lint + format:check         |
| `pnpm clean`       | drop dist/coverage                      |
| `just deps`        | docker compose up postgres/valkey/kafka |
| `just obs`         | docker compose up Jaeger/Prometheus/Grafana |
| `just dev` / `dev-worker` | vite build --watch + restart after each build |
| `just build-watch <app>` | rebuild an app bundle on change, no process |
| `just test-watch[-integration]` | vitest watch, unit / integration project |
| `just setup-sec`   | install the AppSec toolchain (mise)     |
| `just sec`         | expired waivers + gitleaks + semgrep + osv-scanner + hadolint |
| `just docker-build <app>` | build `nodejs-basics-<app>:dev`  |
| `just docker-scan[-ci] <app>` | syft SBOM + grype (`-ci`: fail on HIGH+) |
| `just docker-sign\|verify <app> <tag>` | cosign key-mode sign / offline verify |

## Worktrees (multi-branch dev)

This repo can be cloned as a **bare-repo container** so each branch is a clean
sibling checkout — like the Go/Rust sibling repos. Don't nest worktrees inside a
live checkout, or tooling will scan every branch's `node_modules` / `dist`.

```sh
# one-time container
git clone --bare git@github.com:wundernightmare/nodejs-basics.git nodejs-basics/.bare
cd nodejs-basics && echo 'gitdir: ./.bare' > .git
git --git-dir=.bare config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git fetch origin
git worktree add master master
cp master/wt ./wt && chmod +x ./wt   # the wt helper lives at the container root

# per branch — the `wt` helper wraps the extra setup:
./wt add feat/x          # worktree + mise trust + pnpm install + link secrets
./wt list
./wt rm  feat/x
```

What `git worktree add` does **not** do, and `wt` does:

- `mise trust` the new worktree (else mise-shimmed tools fail with a misleading
  "error parsing config file");
- `pnpm install` to wire up node_modules + native deps (the global pnpm store
  makes this mostly hardlinks — fast);
- link machine-local secrets/config (`.env*`, `apps/api/config.yaml`) from the
  canonical `master/` worktree.

**Build cache.** pnpm's content-addressable store
(`~/.local/share/pnpm/store`) is global, so install reuse across worktrees is
automatic. **Docker** `docker/deps.yml` is a singleton (fixed project name
`nodejs-basics-deps` + host ports) — run one deps stack and every worktree
reaches it at `localhost:<port>`.

## License

UNLICENSED — replace with your project's license.
