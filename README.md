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
just dev                           # starts apps/api on :3000, admin :9090
```

Then:

- `curl http://localhost:3000` — main API
- `curl http://localhost:9090/metrics` — Prometheus metrics
- `curl http://localhost:9090/readyz` — readiness probe
- `curl http://localhost:9090/admin/info` — build / runtime info
- `curl -X PUT --data debug http://localhost:9090/admin/log-level` — change
  log level live

Optional observability stack:

```sh
just obs                           # Jaeger :16686, Prometheus :9090
```

### The whole thing in containers (api + worker)

```sh
just stack-up                      # build + run deps + api + worker images
curl -XPOST localhost:3000/tasks -H 'content-type: application/json' -d '{"title":"hi"}'
curl -s localhost:9093/metrics | grep worker_tasks   # the worker drained the event
just stack-down
```

The distroless images build the whole pnpm workspace and ship it on
`gcr.io/distroless/nodejs22` (non-root). The native
`@confluentinc/kafka-javascript` addon links only libstdc++/glibc (librdkafka is
bundled), which the distroless base provides.

### Tests, e2e, load, security

```sh
just stack-up && just e2e          # Playwright API e2e against the running stack
just bench-tasks smoke             # k6 load test (needs the stack up)
just setup-sec                     # one-time: install the AppSec toolchain (mise)
just sec                           # gitleaks + semgrep + osv-scanner + hadolint
just docker-build api              # build an image; docker-scan-ci api → grype --fail-on high
```

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
the very first line of `main.ts`. Library instrumentations (Fastify, NestJS,
Undici, AWS SDK) self-register on construction; if NestJS loads first, those
hooks miss the auto-instrumentation. Don't move it.

### Config priority

```
process.env  >  YAML structured (database.url)  >  YAML flat (DATABASE_URL)  >  defaults
```

Defined once in `packages/config/src/env.registry.ts`. Every config knob your
app reads should be added there — the loader fails fast at startup if a
`required: true` entry is missing.

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

| Service     | Image                          | Port |
|-------------|--------------------------------|------|
| Postgres 18 | `postgres:18`                  | 5432 |
| Valkey 9    | `valkey/valkey:9.0`            | 6379 |
| Redpanda    | `redpandadata/redpanda:v26.1.1`| 9092 |

Default credentials: `app` / `app` for postgres. **Change before deploying.**

## Observability stack (`docker/observability.yml`)

| Service     | Image                                          | Port  |
|-------------|------------------------------------------------|-------|
| Jaeger      | `jaegertracing/all-in-one:1.62`                | 16686 |
| Prometheus  | `prom/prometheus:v3.0.1`                       | 9090  |
| OTel Collector | `otel/opentelemetry-collector-contrib:0.117.0` | 4317  |

Bring up only when you want traces/metrics locally. The API exports without
it — Prometheus is just unscraped, traces are dropped.

## Scripts

| Command            | What it does                            |
|--------------------|-----------------------------------------|
| `pnpm typecheck`   | tsgo --noEmit per package               |
| `pnpm lint`        | oxlint                                  |
| `pnpm format`      | oxfmt                                   |
| `pnpm test`        | vitest run per package                  |
| `pnpm check`       | typecheck + lint + format:check         |
| `pnpm clean`       | drop dist/coverage                      |
| `just deps`        | docker compose up postgres/valkey/kafka |
| `just obs`         | docker compose up Jaeger/Prometheus     |
| `just dev`         | start apps/api in watch mode            |

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
git worktree add main main
cp main/wt ./wt && chmod +x ./wt   # the wt helper lives at the container root

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
  canonical `main/` worktree.

**Build cache.** pnpm's content-addressable store
(`~/.local/share/pnpm/store`) is global, so install reuse across worktrees is
automatic. **Docker** `docker/deps.yml` is a singleton (fixed project name
`nodejs-basics-deps` + host ports) — run one deps stack and every worktree
reaches it at `localhost:<port>`.

## License

UNLICENSED — replace with your project's license.
