# CLAUDE.md

Guidance for AI agents working in this repo. Deep docs live in
[README.md](README.md) and each module's README; this file is only the
high-signal, easy-to-miss bits.

## Build & test

- Fresh clone → `just bootstrap` (mise trust/install, corepack pnpm, frozen
  install, config.yaml from the example, `just deps` = compose up + migrate).
- pnpm workspace (`packages/*`, `apps/*`, `e2e`). Workspace-wide:
  `pnpm check` (typecheck + lint + format), `pnpm test`, `pnpm build`, or the
  `just` recipes (`just check` / `just dev` / `just deps`).
- **Apps are built by Vite, packages by tsc.** `apps/<app>/vite.config.ts` →
  `vite.app.config.ts` (root): one ESM bundle `dist/main.js` per app, SWC
  transform (NestJS needs legacy decorators + `emitDecoratorMetadata`, which
  Vite's oxc transform does not emit), `@base/*` bundled from `src/` (the
  `source` condition — no package build needed), everything else external.
  Bare imports made *by a bundled package* are resolved from that package's
  own node_modules at build time and emitted as paths relative to dist/
  (pnpm's strict layout would not let the app resolve them) — with Node's
  resolution (`node`/`import`/`default` conditions, `main` field, never the
  bundler-only `module` field: @aws-sdk's `dist-es` is not loadable by Node).
  Packages still emit `dist/` with tsc for their declarations and the
  `import` condition. No Nest CLI, no nest-cli.json.
- **Watch mode**: `just dev` / `just dev-worker` = `scripts/dev.mjs`: `vite
  build --watch`, and on each finished build ("built in") the app is restarted
  through its graceful shutdown (not `node --watch-path`, which restarts on a
  half-written bundle) — a save anywhere in the app or a bundled package
  rebuilds in ~70 ms; a broken save keeps the last good build running.
  `just test-watch` / `test-watch-integration` for vitest.
- **Lint/format** are oxlint + oxfmt (Rust-based, fast). Each app/e2e package
  needs its own `.oxlintrc.json` extending the root — oxlint's `typeAware`
  option is only valid in the config it treats as the root, so a package run
  from its own dir must re-anchor to `../.oxlintrc.json`. Every `lint` script
  carries `--max-warnings=N`, a ratchet: fix warnings and lower N, never
  raise it. `import/no-cycle` is an error. The root `scripts/` and config
  files are linted/formatted by the root `lint:root` / `format:check`.
- **Tests** are vitest with ONE root `vitest.config.ts` and two projects:
  `unit` (`*.spec.ts`, `pnpm test`) and `integration` (`*.integration.spec.ts`,
  `pnpm test:integration`, real services from `just deps` via `DATABASE_URL` /
  `VALKEY_URL` / `KAFKA_BROKERS` — `integration()` from `@base/testing` skips
  locally when unset, fails on CI). Import `describe`/`it`/`expect` from
  `vitest` (no globals); label suites with `meta()` and tests with
  `testCase("NB-<n>", story)` — every test is an Allure test. `@base/*`
  resolves to `src/` in tests through `resolve.conditions: ["source"]`.
- **Coverage is one merged number across unit + integration + e2e**
  (`scripts/cover.mjs`, gate in `scripts/cover.config.mjs`, per-package
  no-regression ratchet in CI). The e2e layer spawns the built api + worker
  under `NODE_V8_COVERAGE` (`E2E_SPAWN=1`) — Node flushes counters only when
  the process exits, so the harness waits for the SIGTERM shutdown to finish
  before `scripts/v8-to-istanbul.mjs` (ast-v8-to-istanbul + vite's parser)
  maps the bundles' ranges back to src/** — not c8, which drops a bundle's
  uncovered ranges. `just cov-all` is the only entry point that
  guarantees all three layers; `cov-check` gates on what it finds.
- **No retries** in any layer; a flake is reported (Allure), ticketed, fixed.
- **Property specs** (`*.prop.spec.ts`, fast-check) are unit tests: `pnpm test`
  runs them with 100 cases per property (`propertyRuns()` in `@base/testing`,
  driven by `FC_NUM_RUNS`), `pnpm fuzz` / `just fuzz` with 5000 (nightly `fuzz`
  job). Pin a found counterexample as an `examples:` entry.
- **Mutation testing** is StrykerJS scoped to `packages/resilient-client`
  (`stryker.config.mjs`, `pnpm mutate`, nightly `mutation` job, report in
  `reports/mutation/`). It mutates the tree **in place** (pnpm symlinks and the
  `source` condition do not survive Stryker's sandbox copy) — never run it
  concurrently with a formatter or another vitest run. `vitest.config.ts`
  drops Allure and the integration project when `STRYKER_MUTATOR_WORKER` is
  set; the runner plugin is named by path because Stryker's
  `@stryker-mutator/*` glob looks next to its own package under pnpm.
  `thresholds.break` is a ratchet (50 at 56.8 %). **vitest stays on 4.x until
  @stryker-mutator/vitest-runner supports vitest 5** — under 5.0.0 the runner
  reports nearly every mutant as survived (checked 2026-09-13).
- **Contracts are generated, never edited**: `api/tsp/*.tsp` is the source;
  `api/openapi3/tasks.openapi.yaml`, `api/jsonschema/*.json` (events.tsp,
  `@jsonSchema`) and `packages/contracts/src/{tasksapi,events}.gen.ts` are
  committed outputs (event types: api/scripts/event-types.mjs runs the JSON
  Schemas through openapi-typescript in a 3.1 wrapper — no second
  generator). Producer and consumer use the same `TaskCreatedEvent`.
  `createTasksClient` (openapi-fetch over `paths`) is the typed client — e2e
  uses it (Playwright resolves it to its source through `paths` in
  e2e/tsconfig.json — no package build); in a service pass
  `fetch: resilientFetch(resilientClient)` (passthrough4xx: true). Change
  the TypeSpec, run `just contracts`, commit the outputs; `just contracts-check` (CI `contracts` job) fails on stale outputs and
  on an oasdiff breaking change (waivers: `api/oasdiff-breaking.ignore`).
  `api/` (`@base/api-spec`) holds its own TypeScript 6 for openapi-typescript,
  which prints through the compiler API TypeScript 7 no longer ships. The
  app's zod DTOs mirror the document (`.strict()` ↔ sealed schemas, NUL
  pattern, code-point lengths, UUID `Idempotency-Key`); every error is a
  problem+json `Problem`, 405 (+`Allow`) for a known path with another method.
- **Schemathesis owns "bad input → 4xx"**: `just schemathesis` drives the built
  api from the document (100 examples/operation, `--checks all`); don't
  hand-write "empty title → 400" tests, add constraints to the TypeSpec so a
  schema-compliant request is always accepted and a non-compliant one is a
  400 problem, never a 500. The contract layer
  (`apps/api/src/app.contract.integration.spec.ts`, `loadOpenAPI` from
  `@base/testing`) validates every response of the real app in-process.
- AppSec: `just sec` (gitleaks + semgrep + osv-scanner + hadolint) +
  `just docker-scan-ci <app>` (grype `--fail-on high`). Transitive CVEs are
  pinned out via `overrides` in `pnpm-workspace.yaml` (pnpm 11+ no longer reads
  the `pnpm` field in package.json); waivers go in `osv-scanner.toml` /
  `.grype.yaml` / `minimumReleaseAgeExclude` with a documented removal trigger.

## Worktrees & the mise gotcha

- Multi-branch work can use a **bare-repo container** (see README "Worktrees"),
  matching the Go/Rust siblings: the repo root is a bare container, code lives
  in `master/` (or a branch worktree), and the `wt` helper at the container root
  wraps `git worktree add` + `mise trust` + `pnpm install` + secret linking.
- **The footgun:** a fresh worktree's `mise.toml` isn't trusted; mise-shimmed
  tools then fail with a misleading "error parsing config file". `wt` runs
  `mise trust`; otherwise run it yourself.
- pnpm's store is global + content-addressed → install reuse across worktrees is
  automatic. Docker `docker/deps.yml` is a singleton (fixed ports/project name).

## Conventions & gotchas

- **Config + telemetry first**: `apps/api/src/main.ts` imports
  `./instrumentation.js` before anything else, and that file's first import
  `./boot.js` sets the app's `OTEL_SERVICE_NAME` default and runs
  `yamlConfigLoader()` (from `@base/config/loader`, which imports nothing that
  reads env) — so modules that read `process.env` on load see `config.yaml`.
  Same in `apps/worker`. `env.registry.spec.ts` pins the order.
- **Config values**: give a new registry entry its `type` (+ `min`/`max`) and
  read it with `readInt/readNumber/readBool/readJson/readString(config, KEY) ??
  default` from `@base/config` — never `Number(config.get(...))` with a
  fallback on garbage. Unknown YAML keys and bad values fail the boot.
- **No patching instrumentations**: in the Vite bundle every import is loaded
  before instrumentation.ts runs, so `@opentelemetry/instrumentation-pg` /
  `-nestjs-core` / `-aws-sdk` / `-ioredis`… silently do nothing (checked in
  Jaeger). Spans come from `@fastify/otel`, `UndiciInstrumentation`
  (diagnostics_channel) and explicit wrappers in the packages: `tracePgPool`
  (@base/database), `traceValkeyClient` (@base/cache),
  `KafkaProducerService.send` + `traceKafkaMessage` (@base/kafka, traceparent
  in record headers), `addTraced` + `traceJob` (@base/jobs, carrier in
  `opts.telemetry.metadata`). Use `KafkaProducerService.send()` — the raw producer is not exposed (it is replaced on reconnect).
  `setupTelemetry` must keep the AsyncLocalStorage context manager — without
  it every span is a root and logs lose `trace.id`. Test spans with
  `captureSpans()` from @base/testing.
- **Fastify 5**: pass a pre-built logger via `loggerInstance`, not `logger`
  (the latter only accepts a config object).
- **DI scope**: a provider declared only in `AppModule.providers` is NOT visible
  to feature modules. Cross-cutting bindings (e.g. `UNIT_OF_WORK`) live in a
  `@Global` module (`apps/api/src/unit-of-work.module.ts`).
- **Data services**: `apps/api` (Postgres + Valkey + Kafka) and `apps/worker`
  (Kafka consumer → BullMQ) need the backing services. `just deps` (or
  `just stack-up` for the whole thing in containers). The broker is **Redpanda**
  (Kafka API). Admin servers listen on 9090 in a container; on the host the
  api uses 9091 and the worker 9093 — `start:dev` passes `--admin-port` to
  scripts/dev.mjs and the stack publishes the same ports — so 9090 stays free
  (Cockpit on Fedora, Prometheus) and `docker/prometheus/prometheus.yml`
  scrapes `host.docker.internal:9091/9093` in both modes.
- **Request budget**: `HTTP_REQUEST_TIMEOUT_MS` starts a deadline per request
  (registerRequestContext; `x-request-timeout-ms` can shorten it). Outbound
  calls honour it: Postgres (guardPgPool — ROLLBACK always passes; UoW sets
  `SET LOCAL statement_timeout`), Valkey (guardValkeyClient), HTTP
  (ResilientClient `getRemainingMs` → AbortSignal + header). Spent →
  `DeadlineExceededError` → 504. New dependency client → apply the budget the
  same way (`callBudgetMs` / `remainingMs` from @base/common).
- **Events go through the outbox**: `OutboxWriter.add()` inside
  `uow.runInTransaction` (same transaction as the write), `OutboxRelay`
  publishes (SKIP LOCKED, at least once — consumers must be idempotent). Do
  not call `kafka.send()` from a request path for an event that must not be
  lost. The relay keeps the request's trace (context stored per row). Only a
  non-retryable `KafkaSendError` counts `attempts`; at `OUTBOX_MAX_ATTEMPTS`
  the row stays in the table (`outbox.dead` gauge). Retryable failures (outage,
  queue full) never count — never dead-letter an event for back-pressure.
- **Kafka (`@base/kafka`)** — the rules the code encodes; read its JSDoc first.
  - Produce with `KafkaProducerService.send()`: it connects in the background
    (retrying), replaces a client after a fatal error, and fails only with
    `KafkaSendError` — branch on `retryable` (registry: `KAFKA_SEND_ERRORS`,
    only `rejected` is not). Short back-pressure (`not_connected`, a
    single-message `queue_full`) is waited out for `waitMs` (5 s).
  - Consume with `KafkaConsumerRunner`: you write `handle()` — resolve =
    committed (offset + 1), throw = paused and retried with per-partition
    backoff, `KafkaBackpressureError` = "not now" (5 s cap), return for a
    message that can never succeed. Never commit with a bare
    `commitOffsets()` and never rethrow without a pause (a hot loop).
  - Never race a client's connect() against a timer: it waits up to 30 s for
    metadata, and a disconnect under it crashes the process (`Reconnect`).
  - Config: lz4, producer queue 64 MiB (`KAFKA_PRODUCER_QUEUE_MAX_KBYTES`),
    consumer prefetch 4 MiB; anything else via `KAFKA_EXTRA_PROPERTIES` /
    `KAFKA_PRODUCER_/CONSUMER_EXTRA_PROPERTIES` (e.g. `{"debug":"broker"}`, or
    `cooperative-sticky` — the whole group switches together). Topics are the
    broker's call: the runner asks for its topics before subscribing (a
    consumer subscribed to a missing topic notices it only at the next 5-min
    metadata refresh), a provisioned cluster answers "exists" or refuses; a
    missing topic on send is `not_provisioned`, retryable.
  - Metrics come from librdkafka statistics (`kafkaClientMetrics`) — never a
    topic/partition label on them; logs go through `kafkaLogger`, repeats
    folded for 60 s.
- **Schema = migrations/*.sql**, applied by `apps/migrate` (forward-only,
  checksummed, advisory lock; `just migrate`, `just deps` runs it). Never
  create tables from app code or edit an applied file — add a new one.
  `migrations-safety.spec.ts` rejects DDL that breaks the running release
  (DROP/RENAME COLUMN, SET NOT NULL, CREATE INDEX without CONCURRENTLY on an
  existing table, …) unless the file says `-- migration-safety: reviewed`. The
  integration project migrates in its `globalSetup`, the e2e spawn harness
  and schemathesis.sh before starting the api, docker/stack.yml through the
  one-shot `migrate` service. Its image is a self-contained bundle
  (`nodeApp(dir, { selfContained: true })`: pg inlined, conditions without a
  forced `import` so CJS require()s get CJS builds) + the SQL files.
- **BullMQ connections** must NOT set `commandTimeout` (its blocking poll
  legitimately outlives any per-command timeout) — see `@base/cache`
  `toBullMqOptions`.
- **Docker images**: multi-stage distroless (`gcr.io/distroless/nodejs24-debian13`;
  builder `node:24-trixie`, the same glibc line for the native Kafka addon;
  pnpm via `corepack install` from `packageManager`). The build runs
  `pnpm build` (tsc for packages, Vite for the apps) and copies the whole
  workspace — the app bundle imports its externals by path relative to
  dist/, so the tree must move as one; `.dockerignore` must exclude
  `*.tsbuildinfo` (stale incremental state makes tsc skip emitting `dist`), and
  each `@base/*` package needs `files: ["dist"]`. `CMD ["dist/main.js"]`.

## Pipelines & security

- **CI reads mise.toml (and `packageManager` in package.json), never
  hard-codes versions.** Both pipelines have a `versions` job that runs
  `scripts/mise-pins.sh` (tool pins → GitHub step outputs / GitLab `dotenv`
  artifact, used even in `image:`). If you need a tool in CI, pin it in
  `mise.toml` and read it from there — a literal version in a workflow file
  is a bug waiting to drift. GitLab jobs opt in with `extends: .pins`.
- **Scanners run from version-pinned images on both sides** (gitleaks,
  semgrep, osv-scanner, hadolint, syft, grype) — no marketplace action with
  its own bundled binary, no `curl | sh`, no `:latest`. Local runs go through
  `mise exec --` at the same versions.
- **Every upstream host is a variable with the public default** (`DOCKER_HUB`,
  `GHCR`, `GCR`, `GRYPE_DB_UPDATE_URL`, `OSV_SCANNER_FLAGS`, `SEMGREP_CONFIG`,
  `npm_config_registry` / `COREPACK_NPM_REGISTRY`, …) — the repo is the
  template for closed networks behind a proxy. Never write a bare
  `image: alpine` / `curl https://…` / `apt-get install` into a CI job or
  compose file; prefix images with the registry variable and put new knobs in
  `.env.example` (loaded by `just` and mise) with the same name used as a CI
  variable.
- **`semgrep scan --metrics=off`, never `semgrep ci`** (it calls semgrep.dev).
- **GitHub Actions are pinned to a commit SHA** (`uses: owner/repo@<40-hex> # vX.Y.Z`),
  never a tag; `.github/dependabot.yml` moves the SHA and the comment
  together. `github.*` context never goes into `run:` text — pass it through
  `env:` and expand the variable in the script (shell injection). The `sast`
  job (`p/owasp-top-ten`) blocks both, in every workflow file.
- **pnpm supply-chain policy** lives in `pnpm-workspace.yaml`:
  `minimumReleaseAge: 10080` (7 days), `blockExoticSubdeps`, `trustPolicy:
  no-downgrade`, `allowBuilds` (pnpm 11+ fails the install on an unapproved
  build script) and `overrides` (CVE floors on transitive deps); `.npmrc`
  keeps `min-release-age=7` in step. A needed-now release goes into
  `minimumReleaseAgeExclude` with a `Remove after YYYY-MM-DD` line, like every
  dated waiver: `scripts/check-waivers.sh` (`just sec`, CI `sast`, nightly
  appsec run) fails once the date has passed. The docker workflow also runs
  weekly with `pull: true`, so a stale or newly vulnerable base image turns
  it red without a commit.
- **Signing is local-only**: `just docker-sign` / `docker-verify <image>` use
  cosign in key mode with `--tlog-upload=false` (`COSIGN_PRIVATE_KEY` from
  `.env`) on a *pushed* image reference — cosign cannot sign a local tag;
  CI builds, SBOMs (syft, 7-day artifact) and scans but does not push or sign.
