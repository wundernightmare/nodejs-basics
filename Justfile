# nodejs-basics — task runner
# Install just: https://just.systems/man/en/packages.html
# Usage:   just <recipe>   |   just --list

set shell := ["bash", "-c"]
# Load the (gitignored) .env — proxy, registry mirrors, scanner DB mirrors,
# signing key — into every recipe. Absent file = no-op. Knobs: .env.example.
set dotenv-load := true

API  := "apps/api"
DEPS := "docker/deps.yml"
OBS  := "docker/observability.yml"

# Scanner inputs that a closed network points at vendored rules / offline DBs
# (same names as the CI variables; defaults are the public upstreams).
SEMGREP_CONFIG := env("SEMGREP_CONFIG", "p/owasp-top-ten p/typescript")
OSV_SCANNER_FLAGS := env("OSV_SCANNER_FLAGS", "")
# Proxy settings forwarded into every `docker build`. A value-less --build-arg
# takes the variable from the environment and is skipped when unset (these are
# Docker's predefined args, so the Dockerfiles need no ARG for them).
DOCKER_BUILD_ARGS := "--build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg NO_PROXY"

# List available recipes
default:
    @just --list --unsorted

# ── Workspace ─────────────────────────────────────────────────────────────────

# Install all workspace dependencies
install:
    pnpm install

# Full workspace check: typecheck + lint + format
check:
    pnpm check

# Clean all build artefacts
clean:
    pnpm clean

# ── Infrastructure ────────────────────────────────────────────────────────────

# Start deps: PostgreSQL :5432, Valkey :6379
deps:
    docker compose -f {{DEPS}} up -d

# Start observability stack
obs:
    docker compose -f {{OBS}} up -d

# Start everything
up: deps obs

# Stop deps
down-deps:
    docker compose -f {{DEPS}} down

# Stop observability
down-obs:
    docker compose -f {{OBS}} down

# Stop everything (obs first — it's attached to deps' network)
down:
    docker compose -f {{OBS}} down
    docker compose -f {{DEPS}} down

# Stop everything and wipe volumes
down-all:
    docker compose -f {{OBS}} down -v
    docker compose -f {{DEPS}} down -v

# ── Development ───────────────────────────────────────────────────────────────

# Start API in watch mode. Run `just deps` first.
dev:
    cd {{API}} && pnpm start:dev

# Build all packages
build:
    pnpm -r build

# ── Application stack (api + worker images vs deps) ───────────────────────────

# Build the app images, then run the whole stack (deps + api + worker)
stack-up: deps
    docker compose -f docker/stack.yml up -d --build

# Tear the whole stack down (app + deps + volumes)
stack-down:
    docker compose -f docker/stack.yml down -v
    docker compose -f {{DEPS}} down -v

# ── Security (AppSec) — tools pinned in mise.toml, installed by `just setup-sec` ─

# One-time: install the AppSec toolchain via mise (idempotent)
setup-sec:
    mise install semgrep gitleaks osv-scanner hadolint syft grype cosign

# Run all source-side AppSec checks fail-fast
sec: sec-secrets sec-sast sec-deps sec-iac
    @echo "AppSec source checks passed"

# Secrets — gitleaks across the working tree + history
sec-secrets:
    mise exec -- gitleaks detect --source . --config .gitleaks.toml --verbose

# SAST — semgrep rule packs (SEMGREP_CONFIG; a directory of vendored rules offline)
sec-sast:
    #!/usr/bin/env bash
    set -euo pipefail
    cfg=(); for c in {{SEMGREP_CONFIG}}; do cfg+=(--config "$c"); done
    mise exec -- semgrep scan "${cfg[@]}" --error --metrics=off

# Dependencies — osv-scanner over pnpm-lock.yaml (OSV_SCANNER_FLAGS: --offline …)
sec-deps:
    mise exec -- osv-scanner scan --config osv-scanner.toml --lockfile pnpm-lock.yaml {{OSV_SCANNER_FLAGS}}

# IaC — hadolint on every apps/*/Dockerfile
sec-iac:
    #!/usr/bin/env bash
    set -euo pipefail
    find apps -name Dockerfile -print0 | xargs -0 -I{} mise exec -- hadolint --config .hadolint.yaml {}

# ── Container CVE / SBOM / signing ────────────────────────────────────────────

# Build a single app image locally (context = repo root). APP is api|worker.
docker-build APP:
    docker build {{DOCKER_BUILD_ARGS}} -f apps/{{APP}}/Dockerfile -t nodejs-basics-{{APP}}:dev .

# Build all app images (every apps/*/Dockerfile)
docker-build-all:
    #!/usr/bin/env bash
    set -euo pipefail
    for d in apps/*/Dockerfile; do a=$(basename "$(dirname "$d")"); echo "── image $a"; docker build {{DOCKER_BUILD_ARGS}} -f "$d" -t "nodejs-basics-$a:dev" .; done

# syft SBOM + grype CVE scan of a locally-built image (interactive)
docker-scan APP:
    mise exec -- syft nodejs-basics-{{APP}}:dev -o cyclonedx-json=sbom-{{APP}}.json
    mise exec -- grype nodejs-basics-{{APP}}:dev --config .grype.yaml

# Same scan but fail on HIGH+ — the CI variant
docker-scan-ci APP:
    mise exec -- grype nodejs-basics-{{APP}}:dev --config .grype.yaml --fail-on high

# Sign an image with cosign (key-mode, no Rekor); needs COSIGN_PRIVATE_KEY (see .env.example)
docker-sign APP TAG:
    mise exec -- cosign sign --key env://COSIGN_PRIVATE_KEY --tlog-upload=false nodejs-basics-{{APP}}:{{TAG}}

# Offline-verify an image against cosign.pub
docker-verify APP TAG:
    mise exec -- cosign verify --key cosign.pub --insecure-ignore-tlog=true nodejs-basics-{{APP}}:{{TAG}}

# ── Tests — see README "Tests" (layers, harness, Allure, coverage) ───────────

# Unit layer: vitest project `unit` (no services)
test:
    pnpm test

# Integration layer: vitest project `integration` against `just deps` (DATABASE_URL /
# VALKEY_URL / KAFKA_BROKERS; a suite whose service is unset skips locally, fails on CI)
test-integration:
    DATABASE_URL="${DATABASE_URL:-postgresql://app:app@localhost:5432/app}" \
    VALKEY_URL="${VALKEY_URL:-redis://localhost:6379}" \
    KAFKA_BROKERS="${KAFKA_BROKERS:-localhost:9092}" \
    pnpm test:integration

# Every vitest layer (unit + integration)
test-all: test test-integration

# Watch mode for the unit layer
test-watch:
    pnpm test:watch

# ── Coverage — one number, three layers (scripts/cover.mjs) ───────────────────

# Unit-layer coverage → .cover/unit
cov-unit:
    node scripts/cover.mjs unit

# Integration-layer coverage → .cover/integration (needs `just deps`)
cov-integration:
    DATABASE_URL="${DATABASE_URL:-postgresql://app:app@localhost:5432/app}" \
    VALKEY_URL="${VALKEY_URL:-redis://localhost:6379}" \
    KAFKA_BROKERS="${KAFKA_BROKERS:-localhost:9092}" \
    node scripts/cover.mjs integration

# E2E-layer coverage → .cover/e2e: builds, spawns api + worker under NODE_V8_COVERAGE
# against `just deps`, runs Playwright, remaps the counters to src/** (c8)
cov-e2e: deps
    node scripts/cover.mjs e2e

# Merge whatever layers are under .cover/ and gate (scripts/cover.config.mjs).
# Gates on what it finds — `cov-all` is the only entry point that guarantees all three.
cov-check:
    node scripts/cover.mjs merge

# Collect all three layers from scratch, merge, gate — what the `coverage` CI job does
cov-all:
    rm -rf .cover coverage-merged.lcov coverage-breakdown.json
    just cov-unit
    just cov-integration
    just cov-e2e
    just cov-check

# ── Allure — one report from every layer's results ────────────────────────────

# Single-file HTML report from ./allure-results (vitest + Playwright write there;
# ALLURE_RESULTS_DIR redirects). categories.json + executor.json via scripts/allure-meta.sh.
allure-report:
    scripts/allure-meta.sh allure-results
    mise exec -- pnpm exec allure generate --clean --single-file -o allure-report allure-results
    @echo "report: allure-report/index.html"

# ── E2E (Playwright) ──────────────────────────────────────────────────────────

# Install the Playwright test runner (API tests need no browsers)
e2e-install:
    pnpm install
    pnpm --filter @base/e2e exec playwright install --no-shell || true

# Run the e2e suite against the running stack (builds + brings it up first)
e2e: stack-up
    cd e2e && pnpm test

# The @smoke subset against the production images — what the `e2e-stack` CI job proves
e2e-smoke: stack-up
    cd e2e && pnpm test:smoke

# Run the e2e suite against api + worker spawned from dist/ (no images; `just deps` + `pnpm build`)
e2e-spawn: deps
    pnpm build
    cd e2e && E2E_SPAWN=1 pnpm test

# Open the last Playwright report
e2e-report:
    cd e2e && pnpm report

# ── k6 load tests ─────────────────────────────────────────────────────────────

# Load-test the tasks API (needs the stack up: `just stack-up`).
# PROFILE is one of smoke|load|stress|soak.
bench-tasks PROFILE="smoke":
    ./benchmarks/run-k6-tasks.sh {{PROFILE}}
