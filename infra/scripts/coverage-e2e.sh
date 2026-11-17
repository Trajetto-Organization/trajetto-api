#!/usr/bin/env bash
# Measures the integration suite's coverage in batches and merges the result
# with the unit run (decision 13.1).
#
# Batches of 8 files per process: under Prisma 6 the native query engine
# panicked on this kind of host when one process loaded ~12+ E2E files, and 8
# was the measured safe size. Prisma 7 has no native engine; the size stays
# until larger batches are measured. Needs the same DATABASE_URL / REDIS_URL
# the E2E suite needs.
#
# Run it on a tree nobody is editing: merge-coverage.mjs refuses reports
# whose source changed between batches, and this script refuses to merge when
# the src tree's digest changed while the batches ran (an added function can
# leave every statement map intact, so the reports alone cannot show it).
#
# The files of the one-file-at-a-time phase (tests/E2E/support/replica-files.ts)
# run after the batches, one file per batch, as `yarn test:e2e` runs them: the
# ones that start API replicas (beside seven other files, the processes they
# start were load the timing-sensitive tests felt) and the cluster-sensitive
# ones (SERIAL_E2E_FILES: a write transaction open in another batch's
# database holds back the pruning a HOT update needs, plano-escala F2-13).
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

# Every name in each `const <NAME>_E2E_FILES = [...] as const;` list, whether
# Prettier spreads it over lines or keeps it on one: a pattern for the spread
# form alone never read SERIAL_E2E_FILES, a list of one, and its file ran in
# a batch of eight. tests/unitaires/quality/coverage-e2e-script.test.ts runs
# this against every file of the phase vite.config.mts builds.
mapfile -t replica_names < <(
  tr -d '\r' < tests/E2E/support/replica-files.ts |
    awk '/^const [A-Z_]+_E2E_FILES = \[/ { on = 1 } on { print } on && /\] as const;/ { on = 0 }' |
    grep -o '"[^"]*\.test\.ts"' | tr -d '"'
)
if [ "${#replica_names[@]}" -eq 0 ]; then
  echo "tests/E2E/support/replica-files.ts: no file read from the list" >&2
  exit 1
fi

is_replica_file() {
  local name
  for name in "${replica_names[@]}"; do
    [ "$1" = "tests/E2E/$name" ] && return 0
  done
  return 1
}

files=()
replica_files=()
while IFS= read -r file; do
  if is_replica_file "$file"; then
    replica_files+=("$file")
  else
    files+=("$file")
  fi
done < <(find tests/E2E -name '*.test.ts' | sort)
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
    # A process that dies (Prisma 6's engine panic was one way) leaves no
    # report, which would drop the batch from the total. Re-run it in two
    # halves.
    if [ ! -f "$dir/coverage-final.json" ] && [ "${#chunk[@]}" -gt 1 ]; then
      half=$(((${#chunk[@]} + 1) / 2))
      run_batch "$dir-a" "${chunk[@]:0:half}" || echo "batch $batch-a failed" >&2
      run_batch "$dir-b" "${chunk[@]:half}" || echo "batch $batch-b failed" >&2
    fi
  fi
  batch=$((batch + 1))
done

for file in "${replica_files[@]}"; do
  dir=$(printf 'coverage/e2e/%02d' "$batch")
  if ! run_batch "$dir" "$file"; then
    echo "batch $batch failed: $file" >&2
    failed=$((failed + 1))
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
