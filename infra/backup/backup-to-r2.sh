#!/bin/sh
#
# The scheduled, OFF-HOST backup of the production database.
#
# Runs inside the trajetto-backup service (infra/backup/Dockerfile), started
# every night by backup-loop.sh. For a drill: `docker exec <task> backup-to-r2`.
#
# Why it exists: until 09/2026 the only backup was infra/scripts/backup-postgres.sh,
# run by hand and written to the database's own host — while five jobs delete
# data every night (03:17 to 04:10 UTC, one of them DROPping trail
# partitions). A dead disk, a `docker volume rm` or a wrong purge predicate
# had no way back.
#
# What one run does, and refuses to do:
#   1. pg_dump over the network (no Docker socket: a sidecar holding it would
#      be root on the host for whoever compromised it). Custom format.
#   2. Refuses a failed pg_dump, a dump under 1 KB, or one whose table of
#      contents does not read back with pg_restore. (The TOC check reads no
#      data: a dump cut mid-table fails on pg_dump's exit status, and the data
#      itself is proven by the restore drill.)
#   3. Encrypts with age BEFORE anything leaves the container: the dump holds
#      every tenant's personal data. Only the public recipient lives here; the
#      private identity lives offline (docs/deploy.md (Backup e restauração)).
#   4. Uploads the .age file and its .sha256 to a SEPARATE R2 bucket under
#      pg/daily/YYYY/MM/DD/, plus server-side copies under pg/weekly/ on
#      Sundays and pg/monthly/ on the 1st. Retention and immutability are the
#      bucket's lifecycle rules and Bucket Lock, not this script.
#   5. Pings the heartbeat on success, `<url>/fail` on any failure. The
#      monitor alerts on a failure AND on silence.
#   Nothing stays on disk: the work directory is removed on every exit.
#
# POSIX sh, no pipefail: this runs on the image's busybox ash. Every step that
# matters is checked explicitly instead of through a pipeline.
set -eu

heartbeat() {
  [ -n "${BACKUP_HEARTBEAT_URL:-}" ] || return 0

  curl -fsS -m 10 --retry 3 -o /dev/null "${BACKUP_HEARTBEAT_URL}$1" \
    || echo "[backup] aviso: o heartbeat${1:+ $1} não respondeu" >&2
}

fail() {
  echo "[backup] ERRO: $*" >&2
  heartbeat /fail
  exit 1
}

for name in PGHOST PGUSER PGPASSWORD PGDATABASE \
  BACKUP_R2_ACCOUNT_ID BACKUP_R2_BUCKET BACKUP_R2_ACCESS_KEY_ID \
  BACKUP_R2_SECRET_ACCESS_KEY BACKUP_AGE_RECIPIENT BACKUP_HEARTBEAT_URL; do
  eval "value=\${${name}:-}"

  [ -n "$value" ] || fail "defina ${name} (docs/deploy.md (Backup e restauração))"
done

# One clock read, so the file name and the folders can never straddle midnight.
# shellcheck disable=SC2046
set -- $(date -u '+%Y %m %d %u %H%M%S')
YEAR="$1" MONTH="$2" DAY="$3" WEEKDAY="$4" TIME="$5"

NAME="${PGDATABASE}-${YEAR}${MONTH}${DAY}T${TIME}Z.dump"
FOLDER="${YEAR}/${MONTH}/${DAY}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Opt-in: the trail's rows (driver_position, the bulk of the database at
# scale) left out of the logical dump; its schema stays. With it on, the
# trail is outside this backup's RPO — docs/deploy.md (Backup e restauração).
EXCLUDE=""

if [ "${BACKUP_EXCLUDE_TRAIL:-false}" = "true" ]; then
  EXCLUDE="--exclude-table-data-and-children=public.driver_position"
fi

echo "[backup] pg_dump de ${PGDATABASE}@${PGHOST}${EXCLUDE:+ (sem os dados da trilha)}"

# --no-owner --no-privileges: restorable as whatever role the recovery has.
# shellcheck disable=SC2086
pg_dump -Fc -Z 6 --no-owner --no-privileges $EXCLUDE -f "$WORK/$NAME" \
  || fail "pg_dump falhou"

SIZE="$(wc -c < "$WORK/$NAME" | tr -d ' ')"

[ "$SIZE" -ge 1024 ] || fail "o dump tem só ${SIZE} bytes"

pg_restore --list "$WORK/$NAME" > /dev/null \
  || fail "o índice (TOC) do dump não lê de volta"

age -r "$BACKUP_AGE_RECIPIENT" -o "$WORK/$NAME.age" "$WORK/$NAME" \
  || fail "a cifra com age falhou"

rm -f "$WORK/$NAME"

(cd "$WORK" && sha256sum "$NAME.age" > "$NAME.age.sha256") \
  || fail "o sha256 falhou"

# rclone configured through its environment: no config file with the key.
# NO_CHECK_BUCKET because the token is scoped to one bucket and may not list
# or create buckets.
export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ENDPOINT="https://${BACKUP_R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$BACKUP_R2_ACCESS_KEY_ID"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$BACKUP_R2_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true

DEST="r2:${BACKUP_R2_BUCKET}/pg"

for file in "$NAME.age" "$NAME.age.sha256"; do
  rclone copyto "$WORK/$file" "$DEST/daily/$FOLDER/$file" \
    || fail "o upload de ${file} falhou"
done

# Server-side copies: nothing is uploaded twice.
if [ "$WEEKDAY" = "7" ]; then
  for file in "$NAME.age" "$NAME.age.sha256"; do
    rclone copyto "$DEST/daily/$FOLDER/$file" "$DEST/weekly/$FOLDER/$file" \
      || fail "a cópia semanal de ${file} falhou"
  done
fi

if [ "$DAY" = "01" ]; then
  for file in "$NAME.age" "$NAME.age.sha256"; do
    rclone copyto "$DEST/daily/$FOLDER/$file" "$DEST/monthly/$FOLDER/$file" \
      || fail "a cópia mensal de ${file} falhou"
  done
fi

echo "[backup] ok: ${NAME}.age (${SIZE} bytes antes da cifra) em ${DEST}/daily/${FOLDER}/"

heartbeat ""
