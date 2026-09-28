#!/bin/sh
# check-waivers.sh — fail on any expired, time-boxed waiver.
#
#   scripts/check-waivers.sh                    # today (UTC)
#   TODAY=2026-10-01 scripts/check-waivers.sh   # what will expire by then
#
# Every waiver in this repo (pnpm minimumReleaseAgeExclude / trustPolicyExclude
# in pnpm-workspace.yaml, CVE ignores in osv-scanner.toml / .grype.yaml,
# oasdiff exceptions in api/oasdiff-breaking.ignore, …) carries a removal
# trigger. When the trigger is a date, write it as `Remove after YYYY-MM-DD`
# and this script turns it into a gate: once the date has passed, `just sec`
# and the CI `sast` job (also on its nightly schedule, since nothing has to be
# committed for a waiver to expire) fail until the waiver is removed or
# consciously re-dated with a reason. Same script and convention as the
# golang-basics sibling.
#
# Scans every tracked and untracked-but-not-ignored text file (git grep), so a
# new waiver file needs no registration here. Markdown is skipped: docs talk
# about the convention, they do not carry waivers.
#
# POSIX sh + awk: the CI job runs it in the semgrep image.
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
today="${TODAY:-$(date -u +%Y-%m-%d)}"
pattern='[Rr]emove after [0-9]{4}-[0-9]{2}-[0-9]{2}'

if command -v git >/dev/null 2>&1 && git -C "$root" rev-parse --git-dir >/dev/null 2>&1; then
  hits="$(git -C "$root" grep --untracked -nIE "$pattern" -- . ':!*.md' ':!scripts/check-waivers.sh' || true)"
else
  hits="$(cd "$root" && grep -rnIE "$pattern" --exclude='*.md' --exclude=check-waivers.sh \
    --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.cover . || true)"
fi

printf '%s\n' "$hits" | awk -v today="$today" '
  NF == 0 { next }
  {
    line = $0
    while (match(line, /[Rr]emove after [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]/)) {
      d = substr(line, RSTART + RLENGTH - 10, 10)
      if (d < today) { print "expired waiver (" d " < " today "): " $0; bad++ }
      else ok++
      line = substr(line, RSTART + RLENGTH)
    }
  }
  END {
    if (bad) { printf "check-waivers: %d expired waiver(s) — remove them or re-date with a reason\n", bad > "/dev/stderr"; exit 1 }
    printf "check-waivers: %d dated waiver(s), none expired (today %s)\n", ok + 0, today
  }'
