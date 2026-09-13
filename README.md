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
- `curl http://localhost:9090/version` — service, version, revision, start time / uptime (`/admin/info` is an alias)
- `curl http://localhost:9090/admin/config` — the effective config, secrets redacted
- `curl -X PUT -H "Authorization: Bearer $ADMIN_TOKEN" 'http://localhost:9090/admin/log-level?level=debug&ttl=30m'` — change
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
just test                          # unit layer (vitest project `unit`)
just deps && just test-integration # integration layer against real Postgres / Valkey / Redpanda
just stack-up && just e2e          # Playwright API e2e against the production images
just cov-all                       # all three layers → one merged coverage number, gated
just allure-report                 # one HTML report from every layer's allure-results/
just bench-tasks smoke             # k6 load test (needs the stack up)
just setup-sec                     # one-time: install the AppSec toolchain (mise)
just sec                           # gitleaks + semgrep + osv-scanner + hadolint
just docker-build api              # build an image; docker-scan-ci api → grype --fail-on high
```

See [Tests](#tests) for the layers, the harness and the coverage / Allure flow.

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

## Tests

Every test in the workspace is an Allure test, every layer feeds one merged
coverage number, and every behaviour is checked at exactly one layer — the
same contract as the Go sibling. The harness that makes that cheap is
[`packages/testing`](packages/testing) (`@base/testing`, test-only).

### Layers and what each one owns

| Layer | Where | Owns | Does not repeat |
|---|---|---|---|
| **Unit** | `*.spec.ts` next to the code — vitest project `unit`, `just test` | pure logic: config builders, backoff, the resilient client against a mock agent, redaction, the runtime log level, the admin router over an in-process `node:http` server | anything that needs a real dependency |
| **Integration** | `*.integration.spec.ts` — vitest project `integration`, `just test-integration` | the libs against real Postgres / Valkey / Redpanda from `docker/deps.yml`: the unit of work commits and rolls back as one, the Valkey option bag connects and BullMQ's blocking poll outlives the command timeout | route behaviour already proven with fakes; process-level behaviour |
| **E2E** | [`e2e/`](e2e) (Playwright, API tests) — `just e2e` (production images) / `just e2e-spawn` (built processes) | what only a real process shows: it boots, is ready on its admin listener, is a scrape target, and the cross-process flow api → Kafka → worker → BullMQ | per-route behaviour, error bodies (unit), the libs' semantics (integration) |
| **Smoke** | the `@smoke` titles in `e2e/` — `just e2e-smoke`, the `e2e-stack` CI job | the distroless images start and serve | everything else |
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
the counters) and c8 remaps the raw V8 output to `src/**` through the emitted
source maps. `merge` unions them **per line**: the executable lines of every
file are what vitest reports (it lists every included file, covered or not —
c8's remapped maps count comment lines too, so they only contribute hits), and
a line is covered when any layer hit it. Nothing is counted twice; it writes
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
| `just sec-secrets` | gitleaks    | `.gitleaks.toml`   | secrets in tree + history                     |
| `just sec-sast`    | semgrep     | `.semgrepignore`   | `p/owasp-top-ten` + `p/typescript` packs      |
| `just sec-deps`    | osv-scanner | `osv-scanner.toml` | OSV.dev advisories over `pnpm-lock.yaml`      |
| `just sec-iac`     | hadolint    | `.hadolint.yaml`   | every `apps/*/Dockerfile`                     |
| `just sec`         | —           | —                  | runs the four source-side checks fail-fast    |

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
| `allowBuilds`              | the only postinstall scripts allowed to run (pnpm 11 fails the install otherwise)       |
| `overrides`                | CVE floors on transitive deps we don't declare directly                                 |
| `minimumReleaseAgeExclude` | the escape hatch — time-boxed, with a "remove after <date>" comment                     |

Waivers that cannot be pinned out go in `osv-scanner.toml` / `.grype.yaml`,
each with the reason and a removal trigger.

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
| `pnpm typecheck`   | tsgo --noEmit per package               |
| `pnpm lint`        | oxlint                                  |
| `pnpm format`      | oxfmt                                   |
| `pnpm test`        | unit layer (vitest project `unit`)      |
| `pnpm test:integration` | integration layer (needs `just deps`) |
| `just cov-all` / `cov-check` | three-layer coverage, merged + gated |
| `just allure-report` | one Allure HTML report from every layer |
| `just e2e` / `e2e-smoke` / `e2e-spawn` | Playwright vs images / @smoke / spawned processes |
| `pnpm check`       | typecheck + lint + format:check         |
| `pnpm clean`       | drop dist/coverage                      |
| `just deps`        | docker compose up postgres/valkey/kafka |
| `just obs`         | docker compose up Jaeger/Prometheus     |
| `just dev`         | start apps/api in watch mode            |
| `just setup-sec`   | install the AppSec toolchain (mise)     |
| `just sec`         | gitleaks + semgrep + osv-scanner + hadolint |
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
