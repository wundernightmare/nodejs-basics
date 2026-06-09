#!/usr/bin/env bash
# run-k6-tasks.sh — k6 load test against the running tasks API.
#
# Bring the stack up first (`just stack-up`); this script just points k6 at the
# api on :3000 and runs the chosen profile. Results land in benchmarks/results/.
#
# Usage: benchmarks/run-k6-tasks.sh <smoke|load|stress|soak>
set -euo pipefail

SCENARIO="${1:-smoke}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESULTS="$ROOT/benchmarks/results"
BASE_URL="${BASE_URL:-http://localhost:3000}"
mkdir -p "$RESULTS"

log() { printf '\033[36m▸ %s\033[0m\n' "$*"; }

command -v k6 >/dev/null || { echo "k6 not found — install via mise (pinned in mise.toml)" >&2; exit 1; }

log "check the api is up at $BASE_URL"
curl -fsS -o /dev/null "$BASE_URL/health" || { echo "api not reachable — run 'just stack-up' first"; exit 1; }

log "k6 run — scenario=$SCENARIO target=$BASE_URL"
k6 run \
  -e BASE_URL="$BASE_URL" \
  -e SCENARIO="$SCENARIO" \
  --summary-export "$RESULTS/summary-tasks-$SCENARIO.json" \
  "$ROOT/benchmarks/k6-tasks.js" | tee "$RESULTS/stdout-tasks-$SCENARIO.log"

log "done — results in benchmarks/results/ (summary-tasks-$SCENARIO.json)"
