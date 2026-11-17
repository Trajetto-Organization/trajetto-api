#!/usr/bin/env bash
#
# Restores a CUSTOM-FORMAT dump (pg_dump -Fc, the kind backup-postgres.sh
# writes) into a throwaway database.
#
# The primary restore of the scheduled backup is Dokploy's own (the
# PostgreSQL database's Backups tab, restore action). This drill is the manual
# path: a Dokploy backup file downloaded from R2 is gzipped (`gunzip` it
# first) and is fed here only if it is a custom-format archive — when
# pg_restore says it is a text-format dump, it is plain SQL and goes through
# `psql` instead (docs/deploy.md, Backup e restauração).
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

# A dump copied from another host is checked against the checksum written
# next to it (when there is one), before anything is started. A damaged copy
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

# The data directory lives in a named volume, not in the container: the
# feed's xid epoch is set with the server stopped (below), and a stopped
# `--rm` container takes an anonymous volume with it.
VOLUME="${CONTAINER}-data"

cleanup() {
  echo
  echo "Removing drill container..."
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
}

if [ "${KEEP_CONTAINER:-}" != "true" ]; then
  trap cleanup EXIT
fi

echo "Starting disposable Postgres (${CONTAINER}) on port ${PORT}..."

# The image PRODUCTION runs: export POSTGRES_IMAGE with the exact image of the
# Dokploy PostgreSQL database (its Docker Image field, ideally pinned by
# digest), falling back to the same default. A drill on a different image or
# data layout does not prove anything about the database being restored.
IMAGE="${POSTGRES_IMAGE:-postgres:16-alpine}"

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true

# Not `--rm`: the epoch step stops the server and starts it again under
# the same name, and an auto-removal still in flight would take the name.
# cleanup() removes it.
start_postgres() {
  docker run -d \
    --name "$CONTAINER" \
    -e POSTGRES_USER=postgres \
    -e POSTGRES_PASSWORD="$DB_PASSWORD" \
    -e POSTGRES_DB="$DB_NAME" \
    -v "${VOLUME}:/var/lib/postgresql/data" \
    -p "${PORT}:5432" \
    "$IMAGE" >/dev/null

  echo -n "Waiting for it to accept connections"

  for _ in $(seq 1 60); do
    if docker exec "$CONTAINER" pg_isready -U postgres -d "$DB_NAME" >/dev/null 2>&1; then
      echo " ready."
      return 0
    fi

    echo -n "."
    sleep 1
  done

  echo " gave up." >&2
  exit 1
}

start_postgres

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

# The integration feed's stamp (plano-escala F2-03). delivery_event.txid is
# the id of the transaction that wrote each row, and a dump restored into a
# NEW cluster (this drill, a Database created again, another server) brings
# those ids from the old cluster while the new one counts from zero: every
# event written afterwards would sort behind the history, behind every
# integrator's cursor, and never be served. The cure is the xid epoch, set
# with the server stopped: `pg_resetwal -e` puts the next ids above the
# largest stored one (docs/runbooks/feed-txid-regressed.md). The drill does
# it every time it is needed, so the step is rehearsed and not first tried
# in an incident.
TXID_STATE_SQL="SELECT CASE WHEN m.newest >= m.next THEN 'regressed ' || (m.newest / 4294967296 + 1) ELSE 'ok' END
  FROM (SELECT coalesce(max(txid), 0) AS newest,
               pg_snapshot_xmax(pg_current_snapshot())::text::bigint AS next
          FROM delivery_event) m;"

txid_state() {
  docker exec "$CONTAINER" psql -U postgres -d "$DB_NAME" -tA -v ON_ERROR_STOP=1 -c "$TXID_STATE_SQL" | tr -d '[:space:]'
}

STATE="$(txid_state)"

case "$STATE" in
  ok)
    echo "Feed da integração: os txids gravados estão abaixo do próximo xid do cluster."
    ;;
  regressed*)
    EPOCH="${STATE#regressed}"

    echo
    echo "Feed da integração: os txids do dump estão à frente deste cluster; pg_resetwal -e ${EPOCH}..."

    # A clean stop: pg_resetwal refuses a cluster that was not shut down.
    docker stop "$CONTAINER" >/dev/null
    docker rm "$CONTAINER" >/dev/null

    docker run --rm \
      -u postgres \
      -v "${VOLUME}:/var/lib/postgresql/data" \
      --entrypoint pg_resetwal \
      "$IMAGE" -e "$EPOCH" /var/lib/postgresql/data

    start_postgres

    STATE="$(txid_state)"

    if [ "$STATE" != "ok" ]; then
      echo "O pg_resetwal -e ${EPOCH} não pôs o próximo xid acima do maior txid gravado (${STATE})." >&2
      exit 1
    fi

    echo "Feed da integração: época do xid em ${EPOCH}; os eventos novos ficam depois do histórico."
    ;;
  *)
    echo "Não foi possível ler o txid do feed (${STATE})." >&2
    exit 1
    ;;
esac

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
echo
# A real restore (never this drill) is followed by the release step BEFORE
# the runtime comes back: it reapplies infra/sql's owners and grants, which
# a --no-owner restore loses, and the migrations a dump older than the code
# lacks (plano-escala U-11; docs/deploy.md, Backup e restauração).
echo "Num restore de verdade: rode a etapa de release no banco restaurado ANTES de subir a API"
echo "(Deploy na trajetto-api-migrate, ou Run workflow com force_release). Ela devolve os"
echo "roles, os grants e as migrations que faltam; o pipeline sozinho pularia a etapa."
