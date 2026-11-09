#!/usr/bin/env bash
# Runs the current bench/ harness against Lugn source at several commits, so
# baseline and candidates replay identical seeded workloads.
#
#   bench/run-commits.sh <out-dir> <label>=<commit> [...] [-- benchmark args]
#
# Example:
#   bench/run-commits.sh bench/results baseline=3ce45cf best=HEAD -- \
#     --set all --episodes 100 --cpu-scale 12
set -euo pipefail
root=$(git rev-parse --show-toplevel)
out=$(realpath -m "$1")
shift
specs=()
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
  specs+=("$1")
  shift
done
[ "${1:-}" = "--" ] && shift
mkdir -p "$out"
for spec in "${specs[@]}"; do
  label=${spec%%=*}
  commit=${spec#*=}
  tree=$(mktemp -d "${TMPDIR:-/tmp}/lugn-bench.XXXXXX")
  git -C "$root" worktree add --quiet --detach "$tree" "$commit"
  rm -rf "$tree/bench"
  cp -r "$root/bench" "$tree/bench"
  rm -rf "$tree/bench/results"
  cp "$root/tsconfig.bench.json" "$tree/tsconfig.bench.json"
  ln -s "$root/node_modules" "$tree/node_modules"
  (
    cd "$tree"
    npx tsc -p tsconfig.bench.json
    node dist-bench/bench/lighting-latency.js --label "$label" \
      --out "$out/$label.json" "$@"
  ) | tee "$out/$label.txt"
  git -C "$root" worktree remove --force "$tree"
done
