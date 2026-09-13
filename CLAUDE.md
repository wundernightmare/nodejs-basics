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
  before c8 remaps them. `just cov-all` is the only entry point that
  guarantees all three layers; `cov-check` gates on what it finds.
- **No retries** in any layer; a flake is reported (Allure), ticketed, fixed.
- AppSec: `just sec` (gitleaks + semgrep + osv-scanner + hadolint) +
  `just docker-scan-ci <app>` (grype `--fail-on high`). Transitive CVEs are
  pinned out via `overrides` in `pnpm-workspace.yaml` (pnpm 11 no longer reads
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
- **Docker images**: multi-stage distroless (`gcr.io/distroless/nodejs24-debian12`). The
  build copies the whole built workspace; `.dockerignore` must exclude
  `*.tsbuildinfo` (stale incremental state makes tsc skip emitting `dist`), and
  each `@base/*` package needs `files: ["dist"]`.

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
  no-downgrade`, `allowBuilds` (pnpm 11 fails the install on an unapproved
  build script) and `overrides` (CVE floors on transitive deps); `.npmrc`
  keeps `min-release-age=7` in step. A needed-now release goes into
  `minimumReleaseAgeExclude` with a "remove after <date>" comment, like every
  other waiver.
- **Signing is local-only**: `just docker-sign` / `docker-verify` use cosign in
  key mode with `--tlog-upload=false` (`COSIGN_PRIVATE_KEY` from `.env`);
  CI builds, SBOMs (syft, 7-day artifact) and scans but does not push or sign.
