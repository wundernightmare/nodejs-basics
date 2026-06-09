# CLAUDE.md

Guidance for AI agents working in this repo. Deep docs live in
[README.md](README.md) and each module's README; this file is only the
high-signal, easy-to-miss bits.

## Build & test

- pnpm workspace (`packages/*`, `apps/*`, `e2e`). Workspace-wide:
  `pnpm check` (typecheck + lint + format), `pnpm test`, `pnpm build`, or the
  `just` recipes (`just check` / `just dev` / `just deps`).
- **Lint/format** are oxlint + oxfmt (Rust-based, fast). Each app/e2e package
  needs its own `.oxlintrc.json` extending the root — oxlint's `typeAware`
  option is only valid in the config it treats as the root, so a package run
  from its own dir must re-anchor to `../.oxlintrc.json`.
- **Tests** are vitest; packages without test files pass via
  `--passWithNoTests`. The CI `test` job needs Postgres + Valkey
  (`DATABASE_URL` / `VALKEY_URL`).
- AppSec: `just sec` (gitleaks + semgrep + osv-scanner + hadolint) +
  `just docker-scan-ci <app>` (grype `--fail-on high`). Transitive CVEs are
  pinned out via `pnpm.overrides` in the root `package.json`; waivers go in
  `osv-scanner.toml` / `.grype.yaml` with a documented removal trigger.

## Worktrees & the mise gotcha

- Multi-branch work can use a **bare-repo container** (see README "Worktrees"),
  matching the Go/Rust siblings: the repo root is a bare container, code lives
  in `main/` (or a branch worktree), and the `wt` helper at the container root
  wraps `git worktree add` + `mise trust` + `pnpm install` + secret linking.
- **The footgun:** a fresh worktree's `mise.toml` isn't trusted; mise-shimmed
  tools then fail with a misleading "error parsing config file". `wt` runs
  `mise trust`; otherwise run it yourself.
- pnpm's store is global + content-addressed → install reuse across worktrees is
  automatic. Docker `docker/deps.yml` is a singleton (fixed ports/project name).

## Conventions & gotchas

- **Telemetry first**: `apps/api/src/main.ts` imports `./instrumentation.js`
  before anything else so OpenTelemetry registers before NestJS loads. Same in
  `apps/worker`.
- **Fastify 5**: pass a pre-built logger via `loggerInstance`, not `logger`
  (the latter only accepts a config object).
- **DI scope**: a provider declared only in `AppModule.providers` is NOT visible
  to feature modules. Cross-cutting bindings (e.g. `UNIT_OF_WORK`) live in a
  `@Global` module (`apps/api/src/unit-of-work.module.ts`).
- **Data services**: `apps/api` (Postgres + Valkey + Kafka) and `apps/worker`
  (Kafka consumer → BullMQ) need the backing services. `just deps` (or
  `just stack-up` for the whole thing in containers). The broker is **Redpanda**
  (Kafka API). The host admin server defaults to port 9090 — on Fedora that
  clashes with Cockpit, so the stack maps the api admin to host 9091 and the
  worker to 9093.
- **BullMQ connections** must NOT set `commandTimeout` (its blocking poll
  legitimately outlives any per-command timeout) — see `@base/cache`
  `toBullMqOptions`.
- **Docker images**: multi-stage distroless (`gcr.io/distroless/nodejs22`). The
  build copies the whole built workspace; `.dockerignore` must exclude
  `*.tsbuildinfo` (stale incremental state makes tsc skip emitting `dist`), and
  each `@base/*` package needs `files: ["dist"]`.
