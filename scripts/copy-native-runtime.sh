#!/usr/bin/env bash
set -euo pipefail

root=$1
target=$2
declare -A seen=()

copy_library() {
  local path=$1
  [[ -n "$path" && -e "$path" && -z "${seen[$path]:-}" ]] || return
  seen[$path]=1

  local parent
  parent=$(dirname "$path")
  while [[ "$parent" != / ]]; do
    if [[ -L "$parent" ]]; then
      local parent_destination="$target$parent"
      mkdir -p "$(dirname "$parent_destination")"
      cp -a "$parent" "$parent_destination"
      mkdir -p "$target$(readlink -f "$parent")"
    fi
    parent=$(dirname "$parent")
  done

  local destination="$target$path"
  mkdir -p "$(dirname "$destination")"
  cp -a "$path" "$destination"

  if [[ -L "$path" ]]; then
    copy_library "$(readlink -f "$path")"
  fi
}

while IFS= read -r -d '' binary; do
  while IFS= read -r library; do
    copy_library "$library"
  done < <(ldd "$binary" | awk '$2 == "=>" && $3 ~ /^\// { print $3 } $1 ~ /^\// { print $1 }')
done < <(find "$root" -type f \( -name '*.node' -o -name '*.so' -o -name '*.so.*' \) -print0)
