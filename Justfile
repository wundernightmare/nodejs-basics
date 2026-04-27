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
