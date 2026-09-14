#!/usr/bin/env bash
#
# Logical backup of the Trajetto database.
#
# Until this file existed there was no backup of any kind: no script, no job,
# no documentation, nothing in the git history. Production Postgres is a single
# container on a local volume, with no WAL archiving and no replica, and two
# purge crons delete rows every night at 03:30 and 03:45. A bad predicate in
# either of those was, until now, unrecoverable.
#
# What this gives, stated plainly so nobody assumes more:
#   RPO  as old as the last run of this script (daily = up to 24h of loss).
#   RTO  the time to copy a dump and run restore-postgres.sh — minutes, and
#        measured for real in docs/runbook-restore.md rather than guessed.
#   NOT point-in-time recovery. That needs WAL archiving, which is a change to
#        the production service, and is tracked as a follow-up.
#
# Usage:
#   ./infra/scripts/backup-postgres.sh [output-directory]
#
set -euo pipefail

OUTPUT_DIR="${1:-./backups}"

: "${POSTGRES_USERNAME:?POSTGRES_USERNAME is required}"
: "${POSTGRES_DATABASE:?POSTGRES_DATABASE is required}"

CONTAINER="${POSTGRES_CONTAINER:-}"

if [ -z "$CONTAINER" ]; then
  # Swarm appends a task suffix to the service name, so match by prefix.
  CONTAINER="$(docker ps --filter "name=trajetto-database" --format '{{.ID}}' | head -1)"
fi

if [ -z "$CONTAINER" ]; then
  echo "No running trajetto-database container found." >&2
  echo "Set POSTGRES_CONTAINER explicitly if it is named differently." >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="${OUTPUT_DIR}/${POSTGRES_DATABASE}-${STAMP}.dump"

echo "Dumping ${POSTGRES_DATABASE} from container ${CONTAINER}..."

# Run pg_dump INSIDE the container: the client version then always matches the
# server, which is the most common way a dump silently fails to restore.
#
# -Fc      custom format — compressed, and lets pg_restore pick single tables.
# --no-owner --no-privileges
#          so the dump restores as whatever user the drill or the recovery
#          host happens to have, instead of demanding the production role.
docker exec "$CONTAINER" pg_dump \
  -U "$POSTGRES_USERNAME" \
  -d "$POSTGRES_DATABASE" \
  -Fc -Z 6 \
  --no-owner --no-privileges \
  > "$TARGET"

# A dump that exists but is empty is worse than no dump: it looks like success
# on the dashboard and fails at the only moment anyone needs it.
SIZE="$(wc -c < "$TARGET" | tr -d ' ')"

if [ "$SIZE" -lt 1024 ]; then
  echo "Dump is only ${SIZE} bytes — treating as a failure." >&2
  rm -f "$TARGET"
  exit 1
fi

echo "Wrote ${TARGET} (${SIZE} bytes)"
echo
echo "This file is not a backup until it is somewhere else. Copy it off this"
echo "host — the point of a backup is surviving the loss of this machine."
