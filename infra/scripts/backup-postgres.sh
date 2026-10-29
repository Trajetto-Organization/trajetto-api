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
#        measured for real in docs/deploy.md (Backup e restauração) rather than guessed.
#   NOT point-in-time recovery. That needs WAL archiving, which is a change to
#        the production service, and is tracked as a follow-up.
#
# The SCHEDULED, off-host backup is Dokploy's own Database backup (the
# PostgreSQL database's Backups tab, uploading to Cloudflare R2): see
# docs/deploy.md (Backup e restauração). This script is for a manual dump
# before a risky operation, and for drills.
#
# Usage:
#   ./infra/scripts/backup-postgres.sh [output-directory]
#
# Which container: POSTGRES_CONTAINER when set; on the Dokploy host,
# POSTGRES_SERVICE=<appName of the PostgreSQL database> finds its task; with
# neither, the development container (trajetto-database).
#
# The position trail (driver_position and its daily partitions) is the bulk of
# the database at fleet scale, and a dump that always carries it grows to
# hours — one snapshot holding back vacuum on every hot table the whole time:
#   BACKUP_EXCLUDE_TRAIL=true  keep the trail's schema, leave its rows out
#   BACKUP_TRAIL_ONLY=true     dump ONLY the trail, into <db>-trail-<stamp>.dump
# Default: everything — the same scope as Dokploy's daily backup, which always
# dumps the whole database. These two knobs belong to this script only; they
# are not Application variables.
#
set -euo pipefail

OUTPUT_DIR="${1:-./backups}"

: "${POSTGRES_USERNAME:?POSTGRES_USERNAME is required}"
: "${POSTGRES_DATABASE:?POSTGRES_DATABASE is required}"

SCOPE=()
KIND=""

if [ "${BACKUP_EXCLUDE_TRAIL:-false}" = "true" ] && [ "${BACKUP_TRAIL_ONLY:-false}" = "true" ]; then
  echo "BACKUP_EXCLUDE_TRAIL and BACKUP_TRAIL_ONLY are mutually exclusive." >&2
  exit 1
fi

if [ "${BACKUP_EXCLUDE_TRAIL:-false}" = "true" ]; then
  SCOPE=(--exclude-table-data-and-children=public.driver_position)
  echo "Mode: everything except the trail's rows (driver_position)."
elif [ "${BACKUP_TRAIL_ONLY:-false}" = "true" ]; then
  SCOPE=(--table-and-children=public.driver_position)
  KIND="-trail"
  echo "Mode: the trail only (driver_position)."
else
  echo "Mode: full dump."
fi

CONTAINER="${POSTGRES_CONTAINER:-}"

if [ -z "$CONTAINER" ] && [ -n "${POSTGRES_SERVICE:-}" ]; then
  # Staging/production: the Dokploy PostgreSQL database is a Swarm service
  # named after its appName; its task's container carries that name as a
  # label, whatever suffix Swarm gives the container itself.
  CONTAINER="$(docker ps --filter "label=com.docker.swarm.service.name=${POSTGRES_SERVICE}" --format '{{.ID}}' | head -1)"
fi

if [ -z "$CONTAINER" ] && [ -z "${POSTGRES_SERVICE:-}" ]; then
  # Development: compose.development.yaml's container_name.
  CONTAINER="$(docker ps --filter "name=trajetto-database" --format '{{.ID}}' | head -1)"
fi

if [ -z "$CONTAINER" ]; then
  echo "No running Postgres container found${POSTGRES_SERVICE:+ for service ${POSTGRES_SERVICE}}." >&2
  echo "On the Dokploy host set POSTGRES_SERVICE (the database's appName), or POSTGRES_CONTAINER." >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="${OUTPUT_DIR}/${POSTGRES_DATABASE}${KIND}-${STAMP}.dump"

# Written under a name no restore would pick, and only renamed once it is
# known to be whole. The old version streamed straight into $TARGET: a pg_dump
# that died halfway exited here under `set -e`, before any check, and left a
# truncated file that looked exactly like the newest backup.
PARTIAL="${TARGET}.partial"
trap 'rm -f "$PARTIAL"' EXIT

echo "Dumping ${POSTGRES_DATABASE} from container ${CONTAINER}..."

# Run pg_dump INSIDE the container: the client version then always matches the
# server, which is the most common way a dump silently fails to restore.
#
# -Fc      custom format — compressed, and lets pg_restore pick single tables.
# --no-owner --no-privileges
#          so the dump restores as whatever user the drill or the recovery
#          host happens to have, instead of demanding the production role.
# The `${SCOPE[@]+...}` form: an empty array under `set -u` is an error in
# older bash.
docker exec "$CONTAINER" pg_dump \
  -U "$POSTGRES_USERNAME" \
  -d "$POSTGRES_DATABASE" \
  -Fc -Z 6 \
  --no-owner --no-privileges \
  ${SCOPE[@]+"${SCOPE[@]}"} \
  > "$PARTIAL"

# A dump that exists but is empty is worse than no dump: it looks like success
# on the dashboard and fails at the only moment anyone needs it.
SIZE="$(wc -c < "$PARTIAL" | tr -d ' ')"

if [ "$SIZE" -lt 1024 ]; then
  echo "Dump is only ${SIZE} bytes — treating as a failure." >&2
  exit 1
fi

# The archive's table of contents is read back by the same pg_restore that a
# recovery would use: a file that is not a readable archive at all never
# becomes a .dump. It reads the header and the TOC, not the data — a pg_dump
# cut short in the middle of a table is caught by its exit status above, and
# the data itself is proven only by the restore drill.
if ! docker exec -i "$CONTAINER" pg_restore --list < "$PARTIAL" > /dev/null; then
  echo "The dump's table of contents does not read back — treating as a failure." >&2
  exit 1
fi

mv "$PARTIAL" "$TARGET"

# The checksum names the file relatively, so `sha256sum -c` works wherever the
# pair is copied to — and a copy damaged on the way is caught before a restore
# starts, not halfway through one.
(
  cd "$OUTPUT_DIR"
  NAME="$(basename "$TARGET")"

  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum "$NAME" > "${NAME}.sha256"
  else
    shasum -a 256 "$NAME" > "${NAME}.sha256"
  fi
)

echo "Wrote ${TARGET} (${SIZE} bytes) and ${TARGET}.sha256"
echo
echo "This file is not a backup until it is somewhere else. Copy it off this"
echo "host — the point of a backup is surviving the loss of this machine."
