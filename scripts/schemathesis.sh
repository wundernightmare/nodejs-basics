#!/usr/bin/env bash
# schemathesis.sh — property-based API testing against the real process.
#
#   scripts/schemathesis.sh              # needs the deps up: `just deps`
#   SKIP_BUILD=1 scripts/schemathesis.sh # reuse apps/api/dist from a previous build
#   SCHEMATHESIS_ARGS="--include-method PATCH --phases fuzzing" …  # narrow a run
#
# Builds the workspace, starts apps/api from dist/ on a scratch port, waits for
# /readyz on its admin port, then runs Schemathesis against the API's OpenAPI
# document (api/openapi3/tasks.openapi.yaml): generated positive and negative
# requests for every operation, checking that no request yields a 5xx and that
# every response — status, content type, headers, body — matches the contract.
# This is the generative layer of the pyramid: it finds inputs no hand-written
# test thought of. api/schemathesis.toml makes every Schemathesis warning fatal
# (and says which two are expected, where). Results go to Allure (native reporter) under
# ALLURE_RESULTS_DIR, next to every other layer.
#
# Schemathesis runs from its pinned image (SCHEMATHESIS_VERSION in mise.toml,
# DOCKER_HUB for a closed network) unless a `schemathesis` binary is on PATH
# (the GitLab job runs inside the image itself). The container reaches the
# api through host.docker.internal; the api reaches the deps on localhost.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${DOCKER_HUB:-docker.io}/schemathesis/schemathesis:${SCHEMATHESIS_VERSION:-4.27.0}"
results="${ALLURE_RESULTS_DIR:-$root/allure-results}"
spec="api/openapi3/tasks.openapi.yaml"
max_examples="${SCHEMATHESIS_MAX_EXAMPLES:-100}"
# Extra `schemathesis run` arguments (word-split on purpose): narrow to an
# operation or a phase while chasing one finding.
# shellcheck disable=SC2206
extra_args=(${SCHEMATHESIS_ARGS:-})
port="${SCHEMATHESIS_PORT:-18300}"
admin="${SCHEMATHESIS_ADMIN_PORT:-19300}"
entry="$root/apps/api/dist/main.js"
mkdir -p "$results" "$root/.run"

log() { printf '\033[36m▸ %s\033[0m\n' "$*"; }

# SKIP_BUILD=1: a pre-built dist (CI builds once; local reruns after a first run).
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  log "build workspace"
  (cd "$root" && pnpm build >/dev/null)
fi
[ -f "$entry" ] || { echo "schemathesis.sh: $entry missing — run 'pnpm build'" >&2; exit 2; }

log "migrate"
DATABASE_URL="${DATABASE_URL:-postgresql://app:app@localhost:5432/app}" \
  node "$root/apps/migrate/dist/main.js" > "$root/.run/schemathesis-migrate.log" 2>&1 \
  || { cat "$root/.run/schemathesis-migrate.log" >&2; exit 1; }

log "start api on :$port (admin :$admin)"
# cwd = the app dir (config.yaml lookup), same as the e2e spawn harness.
(cd "$root/apps/api" && \
  DATABASE_URL="${DATABASE_URL:-postgresql://app:app@localhost:5432/app}" \
  VALKEY_URL="${VALKEY_URL:-redis://localhost:6379}" \
  KAFKA_BROKERS="${KAFKA_BROKERS:-localhost:9092}" \
  PORT="$port" ADMIN_PORT="$admin" LOG_LEVEL="${LOG_LEVEL:-warn}" NODE_ENV=production OTEL_SERVICE_NAME=api \
  exec node --enable-source-maps "$entry") > "$root/.run/schemathesis-api.log" 2>&1 &
pid=$!
# SIGTERM → graceful shutdown (the e2e harness relies on the same path).
trap 'kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true' EXIT

ready=0
for _ in $(seq 1 150); do
  if ! kill -0 "$pid" 2>/dev/null; then break; fi
  if command -v curl >/dev/null; then curl -fsS -o /dev/null "http://localhost:$admin/readyz" 2>/dev/null && ready=1 && break
  else wget -q -O /dev/null "http://localhost:$admin/readyz" 2>/dev/null && ready=1 && break; fi
  sleep 0.2
done
if [ "$ready" != "1" ]; then
  echo "schemathesis.sh: api did not become ready on :$admin — last log lines:" >&2
  tail -30 "$root/.run/schemathesis-api.log" >&2
  exit 1
fi

log "schemathesis run — $spec against :$port ($max_examples examples/operation)"
if command -v schemathesis >/dev/null; then
  schemathesis --config-file "$root/api/schemathesis.toml" run "$root/$spec" --url "http://localhost:$port" \
    --checks all --max-examples "$max_examples" --report allure --report-allure-path "$results" "${extra_args[@]}"
else
  # host.docker.internal: Docker Desktop / OrbStack resolve it; Linux (and
  # rootless podman behind the docker CLI) needs the host-gateway alias.
  # --user: the results directory belongs to the invoking user; on Linux the
  # image's default user could not write into it (found on the GitHub runner).
  # Rootless podman maps the invoking user to root *inside* the container
  # (any other uid is an unprivileged subuid that cannot write the mount), and
  # an SELinux host (Fedora) labels bind mounts so a container cannot read
  # them — both are read off the daemon, so the same script runs on Docker
  # Desktop, a GitHub runner and a rootless-podman laptop.
  secopts="$(docker info --format '{{.SecurityOptions}}' 2>/dev/null || true)"
  run_as="$(id -u):$(id -g)"
  case "$secopts" in *name=rootless*) run_as="0:0" ;; esac
  extra=()
  case "$secopts" in *name=selinux*) extra+=(--security-opt label=disable) ;; esac
  docker run --rm --add-host=host.docker.internal:host-gateway --user "$run_as" "${extra[@]}" \
    -v "$root/api:/api:ro" -v "$results:/results" "$image" \
    --config-file /api/schemathesis.toml run "/$spec" --url "http://host.docker.internal:$port" \
    --checks all --max-examples "$max_examples" --report allure --report-allure-path /results "${extra_args[@]}"
fi
