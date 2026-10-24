#!/bin/sh
# Usage: sh tsc-baseline.sh <tsconfig> <baseline file> [--write]
# Fails on a TypeScript error that the baseline file does not list. Line and column numbers are dropped from the
# comparison, so moving code does not break it; a second identical error in the same file does.
# Run it in the folder of the tsconfig, after the dependencies are installed.
set -eu
config=$1
baseline=$2
current=$(mktemp)
trap 'rm -f "$current"' EXIT
# tsc exits non-zero when it finds errors, which is the expected state here
npx --no-install tsc --noEmit --pretty false -p "$config" |
  { grep 'error TS' || true; } | sed -E 's/\([0-9]+,[0-9]+\)//' | LC_ALL=C sort > "$current"
if [ "${3:-}" = "--write" ]; then
  cp "$current" "$baseline"
  echo "wrote $(wc -l < "$baseline") errors to $baseline"
  exit 0
fi
new=$(LC_ALL=C comm -13 "$baseline" "$current")
if [ -n "$new" ]; then
  echo "TypeScript errors that $baseline does not list:"
  echo "$new"
  exit 1
fi
fixed=$(LC_ALL=C comm -23 "$baseline" "$current" | wc -l)
echo "no new TypeScript errors ($fixed fixed since the baseline: rerun with --write to shrink it)"
