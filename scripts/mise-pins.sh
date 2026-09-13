#!/bin/sh
# Prints every tool pin as KEY=value lines — the single source of truth both CI
# pipelines read instead of hard-coding versions. Pins come from mise.toml,
# plus the pnpm version from package.json `packageManager` (pnpm is not a mise
# tool here: corepack installs it, so package.json is where it is pinned).
#
#   GitLab:  sh scripts/mise-pins.sh | tee versions.env   (dotenv artifact)
#   GitHub:  scripts/mise-pins.sh >> "$GITHUB_OUTPUT"      (job outputs)
#
# POSIX sh on purpose: the GitLab `versions` job runs it in a bare alpine
# image. Exits non-zero if any expected pin is missing, so a typo in mise.toml
# fails here instead of surfacing later as a broken `image:` tag.
set -eu

mt="${1:-mise.toml}"
pj="$(dirname "$mt")/package.json"

pin() {
  grep -E "^\"?$1\"?[[:space:]]*=" "$mt" | head -1 \
    | sed -E 's/.*=[[:space:]]*"([^"]+)".*/\1/'
}

emit() {
  v="$(pin "$2")"
  if [ -z "$v" ]; then
    echo "mise-pins: no pin for '$2' in $mt" >&2
    exit 1
  fi
  echo "$1=$v"
}

emit NODE_VERSION     node
emit K6_VERSION       k6
emit SEMGREP_VERSION  semgrep
emit GITLEAKS_VERSION gitleaks
emit OSV_VERSION      osv-scanner
emit HADOLINT_VERSION hadolint
emit SYFT_VERSION     syft
emit GRYPE_VERSION    grype
emit COSIGN_VERSION   cosign
# Contracts: oasdiff is a `ubi:` tool (quoted key in mise.toml); Schemathesis
# is not a tool but a pinned image version under [env] (scripts/schemathesis.sh).
emit OASDIFF_VERSION  ubi:oasdiff/oasdiff
emit SCHEMATHESIS_VERSION SCHEMATHESIS_VERSION

pnpm="$(sed -nE 's/.*"packageManager":[[:space:]]*"pnpm@([^"]+)".*/\1/p' "$pj" | head -1)"
if [ -z "$pnpm" ]; then
  echo "mise-pins: no \"packageManager\": \"pnpm@<version>\" in $pj" >&2
  exit 1
fi
echo "PNPM_VERSION=$pnpm"
