#!/usr/bin/env bash
#
# Restores a dump produced by backup-postgres.sh into a throwaway database.
#
# A backup nobody has restored is a hypothesis, not a backup. This script
# exists so that restoring is something the team has actually done, on a
# normal afternoon, rather than something first attempted during an incident.
#
# Usage:
#   ./infra/scripts/restore-postgres.sh <dump-file> [container-name] [port]
#
# See docs/deploy.md (Backup e restauração) for the full drill, including the verification
# that turns "pg_restore exited 0" into "this is the database the application
# expects".
#
set -euo pipefail

DUMP_FILE="${1:?usage: restore-postgres.sh <dump-file> [container] [port]}"
CONTAINER="${2:-pg-restore-drill}"
PORT="${3:-55432}"

DB_NAME="trajetto_restore_drill"
DB_PASSWORD="drill"

if [ ! -f "$DUMP_FILE" ]; then
  echo "Dump file not found: ${DUMP_FILE}" >&2
  exit 1
fi

# This script only ever talks to the disposable container it creates below:
# there is no argument that points it at a real host, and none may be added.
# Restoring into a real environment is a supervised operation that follows
# docs/deploy.md (Backup e restauração). (It used to carry an ALLOW_NON_LOCAL_RESTORE check
# that refused only when the variable said "allow" — a guard that guarded
# nothing, removed rather than kept as false comfort.)

# A dump copied from the backup bucket or another host is checked against the
# checksum written next to it, before anything is started. A damaged copy
# fails here in a second instead of halfway through a restore.
if [ -f "${DUMP_FILE}.sha256" ]; then
  echo "Verifying ${DUMP_FILE}.sha256..."

  if ! (cd "$(dirname "$DUMP_FILE")" && sha256sum -c "$(basename "$DUMP_FILE").sha256"); then
    echo "Checksum mismatch: this file is not the dump that was written." >&2
    exit 1
  fi
else
  echo "No ${DUMP_FILE}.sha256 next to the dump — integrity not verified."
fi

cleanup() {
  echo
  echo "Removing drill container..."
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}

if [ "${KEEP_CONTAINER:-}" != "true" ]; then
  trap cleanup EXIT
fi

echo "Starting disposable Postgres (${CONTAINER}) on port ${PORT}..."

# The image PRODUCTION runs: POSTGRES_IMAGE, the same variable that pins it in
# compose.production.yaml (export the digest you set there), falling back to
# the same default. A drill on a different image or data layout does not
# prove anything about the database being restored.
IMAGE="${POSTGRES_IMAGE:-postgres:16-alpine}"

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

docker run --rm -d \
  --name "$CONTAINER" \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD="$DB_PASSWORD" \
  -e POSTGRES_DB="$DB_NAME" \
  -p "${PORT}:5432" \
  "$IMAGE" >/dev/null

echo -n "Waiting for it to accept connections"

for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -U postgres -d "$DB_NAME" >/dev/null 2>&1; then
    echo " ready."
    break
  fi

  echo -n "."
  sleep 1
done

if ! docker exec "$CONTAINER" pg_isready -U postgres -d "$DB_NAME" >/dev/null 2>&1; then
  echo " gave up." >&2
  exit 1
fi

echo "Restoring ${DUMP_FILE}..."

# --exit-on-error is the difference between a drill and a false negative:
# without it pg_restore reports success having skipped everything it could not
# apply, and the operator walks away believing the dump is good.
docker exec -i "$CONTAINER" pg_restore \
  -U postgres -d "$DB_NAME" \
  --clean --if-exists --no-owner --no-privileges --exit-on-error \
  < "$DUMP_FILE"

echo
echo "Restored. Verifying against the schema the application expects..."

# THE verification. pg_restore exiting 0 only says the file was readable;
# `migrate status` reporting the schema up to date says the restored database
# is structurally the one this codebase runs against.
#
# `status`, never `deploy`. Deploy APPLIES whatever is pending and then
# reports "No pending migrations": a dump older than the code came out of the
# drill looking current, hiding the one gap the drill exists to show. Nothing
# here changes the restored database.
set +e
STATUS="$(DATABASE_URL="postgresql://postgres:${DB_PASSWORD}@localhost:${PORT}/${DB_NAME}?schema=public" \
  npx prisma migrate status 2>&1)"
STATUS_EXIT=$?
set -e

echo "$STATUS"

if [ "$STATUS_EXIT" -ne 0 ] || ! printf '%s' "$STATUS" | grep -q "Database schema is up to date"; then
  echo >&2
  echo "Dump anterior ao código: há migrations pendentes (ou o status falhou) — nada foi aplicado." >&2
  echo "Restaurar este dump exige aplicar as migrations acima de propósito, com o runbook." >&2
  exit 1
fi

echo
echo "Row counts:"

docker exec "$CONTAINER" psql -U postgres -d "$DB_NAME" -t -c \
  "SELECT '  _prisma_migrations: ' || count(*) FROM \"_prisma_migrations\";"

docker exec "$CONTAINER" psql -U postgres -d "$DB_NAME" -t -c \
  "SELECT '  ' || relname || ': ' || n_live_tup
     FROM pg_stat_user_tables
    WHERE n_live_tup > 0
    ORDER BY n_live_tup DESC
    LIMIT 15;"

echo
echo "Drill complete."
