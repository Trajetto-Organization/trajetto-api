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
# See docs/runbook-restore.md for the full drill, including the verification
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

# The guard that matters. This script exists to rehearse, and a rehearsal that
# can reach production is not a rehearsal — it is the accident it was meant to
# prevent. It only ever creates its own container, so there is no argument
# that points it at a real host; the check below is here so that stays true
# if someone later adds one.
if [ "${ALLOW_NON_LOCAL_RESTORE:-}" = "true" ]; then
  echo "Refusing to run: this script restores into a disposable local" >&2
  echo "container by design. Restoring into a real environment is a" >&2
  echo "deliberate, supervised operation — follow docs/runbook-restore.md." >&2
  exit 1
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

# postgres:16-alpine, matching PRODUCTION — not the bitnami image the dev
# compose uses. A drill against a different image and a different data layout
# does not prove anything about the database being restored.
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

docker run --rm -d \
  --name "$CONTAINER" \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD="$DB_PASSWORD" \
  -e POSTGRES_DB="$DB_NAME" \
  -p "${PORT}:5432" \
  postgres:16-alpine >/dev/null

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
# `migrate deploy` reporting nothing pending says the restored database is
# structurally the one this codebase runs against. It costs nothing, because
# Prisma is already a dependency.
DATABASE_URL="postgresql://postgres:${DB_PASSWORD}@localhost:${PORT}/${DB_NAME}?schema=public" \
  npx prisma migrate deploy

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
