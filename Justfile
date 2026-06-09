# nodejs-basics — task runner
# Install just: https://just.systems/man/en/packages.html
# Usage:   just <recipe>   |   just --list

set shell := ["bash", "-c"]

API  := "apps/api"
DEPS := "docker/deps.yml"
OBS  := "docker/observability.yml"

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

# SAST — semgrep OWASP + TypeScript rule packs
sec-sast:
    mise exec -- semgrep --config p/owasp-top-ten --config p/typescript --error

# Dependencies — osv-scanner over pnpm-lock.yaml
sec-deps:
    mise exec -- osv-scanner scan --config osv-scanner.toml --lockfile pnpm-lock.yaml

# IaC — hadolint on every apps/*/Dockerfile
sec-iac:
    #!/usr/bin/env bash
    set -euo pipefail
    find apps -name Dockerfile -print0 | xargs -0 -I{} mise exec -- hadolint --config .hadolint.yaml {}

# ── Container CVE / SBOM / signing ────────────────────────────────────────────

# Build a single app image locally (context = repo root). APP is api|worker.
docker-build APP:
    docker build -f apps/{{APP}}/Dockerfile -t nodejs-basics-{{APP}}:dev .

# Build all app images
docker-build-all:
    docker build -f apps/api/Dockerfile -t nodejs-basics-api:dev .
    docker build -f apps/worker/Dockerfile -t nodejs-basics-worker:dev .

# syft SBOM + grype CVE scan of a locally-built image (interactive)
docker-scan APP:
    mise exec -- syft nodejs-basics-{{APP}}:dev -o cyclonedx-json=sbom-{{APP}}.json
    mise exec -- grype nodejs-basics-{{APP}}:dev --config .grype.yaml

# Same scan but fail on HIGH+ — the CI variant
docker-scan-ci APP:
    mise exec -- grype nodejs-basics-{{APP}}:dev --config .grype.yaml --fail-on high

# Sign an image with cosign (key-mode, no Rekor); needs COSIGN_PRIVATE_KEY
docker-sign APP TAG:
    mise exec -- cosign sign --key env://COSIGN_PRIVATE_KEY --tlog-upload=false nodejs-basics-{{APP}}:{{TAG}}

# Offline-verify an image against cosign.pub
docker-verify APP TAG:
    mise exec -- cosign verify --key cosign.pub --insecure-ignore-tlog=true nodejs-basics-{{APP}}:{{TAG}}

# ── E2E (Playwright) ──────────────────────────────────────────────────────────

# Install the Playwright test runner (API tests need no browsers)
e2e-install:
    pnpm install
    pnpm --filter @base/e2e exec playwright install --no-shell || true

# Run the e2e suite against the running stack (builds + brings it up first)
e2e: stack-up
    cd e2e && pnpm test

# Open the last Playwright report
e2e-report:
    cd e2e && pnpm report

# ── k6 load tests ─────────────────────────────────────────────────────────────

# Load-test the tasks API (needs the stack up: `just stack-up`).
# PROFILE is one of smoke|load|stress|soak.
bench-tasks PROFILE="smoke":
    ./benchmarks/run-k6-tasks.sh {{PROFILE}}
