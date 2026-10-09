#!/usr/bin/env bash
# Measures the integration suite's coverage in batches and merges the result
# with the unit run (decision 13.1).
#
# Batches because the Prisma query engine panics on this kind of host when a
# single process loads ~12+ E2E files; 8 per process is the measured safe
# size. Needs the same DATABASE_URL / REDIS_URL the E2E suite needs.
#
# Run it on a tree nobody is editing: merge-coverage.mjs refuses reports
# whose source changed between batches, and this script refuses to merge when
# the src tree's digest changed while the batches ran (an added function can
# leave every statement map intact, so the reports alone cannot show it).
#
# Usage: bash infra/scripts/coverage-e2e.sh [batch-size]
#   coverage/unit     — from `yarn test:coverage` (run it first to merge it in)
#   coverage/e2e/NN   — one report per batch (NN-a / NN-b when it was split)
#   coverage/e2e-only — every batch, merged
#   coverage/all      — unit + every batch, merged
set -u
cd "$(dirname "$0")/../.."

size="${1:-8}"
rm -rf coverage/e2e coverage/e2e-only coverage/all
mkdir -p coverage/e2e

src_digest() {
  find src -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1
}
start_digest=$(src_digest)

mapfile -t files < <(find tests/E2E -name '*.test.ts' | sort)
failed=0
batch=0

run_batch() {
  local dir="$1"
  shift
  COVERAGE_DIR="$dir" npx vitest run --coverage --reporter=dot \
    --coverage.reporter=json "$@"
}

for ((i = 0; i < ${#files[@]}; i += size)); do
  dir=$(printf 'coverage/e2e/%02d' "$batch")
  chunk=("${files[@]:i:size}")
  # A failing test still leaves its coverage; the exit code is reported, not
  # hidden, so a crash never passes for a smaller number.
  if ! run_batch "$dir" "${chunk[@]}"; then
    echo "batch $batch failed: ${chunk[*]}" >&2
    failed=$((failed + 1))
    # An engine crash kills the process before the report is written, which
    # would drop the batch from the total. Re-run it in two halves.
    if [ ! -f "$dir/coverage-final.json" ] && [ "${#chunk[@]}" -gt 1 ]; then
      half=$(((${#chunk[@]} + 1) / 2))
      run_batch "$dir-a" "${chunk[@]:0:half}" || echo "batch $batch-a failed" >&2
      run_batch "$dir-b" "${chunk[@]:half}" || echo "batch $batch-b failed" >&2
    fi
  fi
  batch=$((batch + 1))
done

if [ "$(src_digest)" != "$start_digest" ]; then
  echo "src changed while the batches ran; refusing to merge. Re-run on a frozen tree." >&2
  exit 1
fi

e2e=(coverage/e2e/*/coverage-final.json)
merge_failed=0
node infra/scripts/merge-coverage.mjs coverage/e2e-only "${e2e[@]}" || merge_failed=1
all=("${e2e[@]}")
[ -f coverage/unit/coverage-final.json ] && all+=(coverage/unit/coverage-final.json)
node infra/scripts/merge-coverage.mjs coverage/all "${all[@]}" || merge_failed=1

echo "batches: $batch, failed: $failed, merge failed: $merge_failed"
exit $((failed > 0 || merge_failed > 0))
