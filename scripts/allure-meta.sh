#!/usr/bin/env bash
# allure-meta.sh <results-dir> — drop the report-wide Allure metadata into a
# results directory right before `allure generate`:
#
#   categories.json  — tracked in allure/categories.json: how failures are
#                      bucketed (product defect vs infrastructure vs flaky)
#   executor.json    — who ran this: the CI system, its build number and URL
#                      (GitHub Actions / GitLab CI from their env; "local"
#                      with `git describe` otherwise), so the report links
#                      back to the run and history keys on the build order.
#
# Used by `just allure-report` and the allure-report CI jobs. CI context is
# read from the environment only — never inline `github.*` into a run: step.
set -euo pipefail

results="${1:?usage: allure-meta.sh <results-dir>}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$results"
cp "$root/allure/categories.json" "$results/categories.json"

if [[ -n "${GITHUB_RUN_ID:-}" ]]; then
  name="GitHub Actions"; type="github"
  url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}"
  build_url="$url/actions/runs/$GITHUB_RUN_ID"
  build_name="${GITHUB_WORKFLOW:-ci} #${GITHUB_RUN_NUMBER:-0}"
  build_order="${GITHUB_RUN_NUMBER:-0}"
elif [[ -n "${CI_PIPELINE_ID:-}" ]]; then
  name="GitLab CI"; type="gitlab"
  url="${CI_PROJECT_URL:-}"
  build_url="${CI_PIPELINE_URL:-}"
  build_name="${CI_PIPELINE_SOURCE:-pipeline} #${CI_PIPELINE_IID:-0}"
  build_order="${CI_PIPELINE_IID:-0}"
else
  name="local"; type="local"
  url=""; build_url=""
  build_name="$(git -C "$root" describe --tags --always --dirty 2>/dev/null || echo dev)"
  build_order="$(date +%s)"
fi

cat > "$results/executor.json" <<EOF
{
  "name": "$name",
  "type": "$type",
  "url": "$url",
  "buildUrl": "$build_url",
  "buildName": "$build_name",
  "buildOrder": $build_order,
  "reportName": "nodejs-basics"
}
EOF
echo "allure-meta: categories.json + executor.json ($name, $build_name) → $results"
