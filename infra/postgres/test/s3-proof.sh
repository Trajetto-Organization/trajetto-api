#!/usr/bin/env bash
#
# The trajetto-postgres image against an S3 server (plano-escala F1-03): the
# `Postgres image` job of validate.yml runs this on the image it just built,
# by its local digest, with MinIO pinned by digest, before staging ever sees
# the image. What `docker build --target test` proves on a posix repository
# is proven here on the S3 API, the way R2 is spoken to: TLS, path-style
# URLs (repo1-s3-uri-style=path) and the region `auto`, both straight from
# the image's pgbackrest.conf.
#
#   infra/postgres/test/s3-proof.sh <image>
#
# MINIO_IMAGE names MinIO (the workflow pins it by digest). PROOF_PREFIX
# (default postgres-s3-proof) prefixes every container, network and volume,
# all removed at the end, failure or not.
#
# The Database container runs as the Dokploy Database will, from the
# environment alone: repo1 with a key that writes, the drill's key that
# only reads (a MinIO policy of its own, as an R2 "Object Read" token):
#   1. stanza-create with archiving off, then PITR_ARCHIVE=on;
#   2. pgbackrest check, trajetto-backup full (the gap check lists the
#      archive through the S3 API), an archive-get;
#   3. two batches of rows around an instant, then trajetto-backup diff;
#   4. trajetto-restore-drill, its host half exactly as the Schedule Job
#      runs it (the script out of the Database's container, piped to
#      bash), to that instant, with the read-only key: the copy holds the
#      first batch only.
# The certificate is MinIO's own, self-signed: TLS is on, its verification
# off (repo1-storage-verify-tls=n); R2's is checked against the image's CA
# bundle.
set -Eeuo pipefail

IMAGE=${1:?uso: s3-proof.sh <imagem>}
: "${MINIO_IMAGE:?MINIO_IMAGE ausente (a MinIO fixada por digest)}"
PREFIX=${PROOF_PREFIX:-postgres-s3-proof}
[[ "$PREFIX" =~ ^[a-z0-9][a-z0-9_.-]*$ ]] || {
  echo "PROOF_PREFIX inválido" >&2
  exit 1
}

NET="${PREFIX}-net"
MINIO="${PREFIX}-minio"
DB="${PREFIX}-db"
VOLUME="${PREFIX}-data"
BUCKET=trajetto-pitr-proof
WORK=$(mktemp -d)
chmod 0700 "$WORK"

random() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
WRITE_KEY="write$(random 8)"
WRITE_SECRET=$(random 20)
READ_KEY="read$(random 8)"
READ_SECRET=$(random 20)

cleanup() {
  docker ps -aq --filter "name=^${PREFIX}-" | xargs -r docker rm -f > /dev/null 2>&1 || true
  docker volume rm "$VOLUME" > /dev/null 2>&1 || true
  docker network rm "$NET" > /dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
  echo "::error::Prova S3 da trajetto-postgres: $1" >&2
  for container in "$DB" "$MINIO"; do
    echo "--- ${container} ---" >&2
    docker logs --tail 60 "$container" 2>&1 | sed -e "s/${WRITE_SECRET}/<redacted>/g" -e "s/${READ_SECRET}/<redacted>/g" >&2 || true
  done
  exit 1
}

ok() { echo "ok - $*"; }

cleanup
docker network create "$NET" > /dev/null
docker volume create "$VOLUME" > /dev/null

# --- MinIO, with TLS, a bucket, and a read-only user ------------------------------

mkdir -p "${WORK}/certs"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=minio" \
  -addext "subjectAltName=DNS:minio" \
  -keyout "${WORK}/certs/private.key" -out "${WORK}/certs/public.crt" > /dev/null 2>&1
chmod 0644 "${WORK}/certs/private.key" "${WORK}/certs/public.crt"

# Files go in by `docker cp`, never a bind mount: the same on a runner and
# in a Docker that runs elsewhere.
docker create --name "$MINIO" --network "$NET" --network-alias minio \
  -e "MINIO_ROOT_USER=${WRITE_KEY}" -e "MINIO_ROOT_PASSWORD=${WRITE_SECRET}" \
  "$MINIO_IMAGE" server /data --address :9000 --certs-dir /certs > /dev/null
docker cp "${WORK}/certs" "${MINIO}:/certs"
docker start "$MINIO" > /dev/null

mc() { docker exec "$MINIO" mc --insecure "$@"; }
for _ in $(seq 1 60); do
  if docker exec "$MINIO" curl -fsk https://127.0.0.1:9000/minio/health/live > /dev/null 2>&1; then break; fi
  sleep 1
done
mc alias set proof https://127.0.0.1:9000 "$WRITE_KEY" "$WRITE_SECRET" > /dev/null \
  || fail "a MinIO não respondeu"
mc mb "proof/${BUCKET}" > /dev/null || fail "não criou o bucket"
# What an R2 "Object Read only" token can do: read and list, nothing else.
cat > "${WORK}/read-policy.json" << EOF
{"Version": "2012-10-17", "Statement": [{"Effect": "Allow",
  "Action": ["s3:GetBucketLocation", "s3:ListBucket", "s3:GetObject"],
  "Resource": ["arn:aws:s3:::${BUCKET}", "arn:aws:s3:::${BUCKET}/*"]}]}
EOF
docker cp "${WORK}/read-policy.json" "${MINIO}:/tmp/read-policy.json"
mc admin policy create proof pitr-read /tmp/read-policy.json > /dev/null || fail "não criou a política de leitura"
mc admin user add proof "$READ_KEY" "$READ_SECRET" > /dev/null || fail "não criou o usuário de leitura"
mc admin policy attach proof pitr-read --user "$READ_KEY" > /dev/null || fail "não ligou a política de leitura"
ok "MinIO com TLS, bucket ${BUCKET}, chave de escrita e chave só de leitura"

# --- the Database, from its environment alone -----------------------------------------

envfile="${WORK}/db.env"
{
  echo "POSTGRES_USER=trajetto"
  echo "POSTGRES_DB=trajetto"
  echo "POSTGRES_PASSWORD=$(random 16)"
  echo "POSTGRES_MEMORY_LIMIT_MB=576"
  echo "PGBACKREST_REPO1_S3_ENDPOINT=minio"
  echo "PGBACKREST_REPO1_STORAGE_PORT=9000"
  echo "PGBACKREST_REPO1_STORAGE_VERIFY_TLS=n"
  echo "PGBACKREST_REPO1_S3_BUCKET=${BUCKET}"
  echo "PGBACKREST_REPO1_S3_KEY=${WRITE_KEY}"
  echo "PGBACKREST_REPO1_S3_KEY_SECRET=${WRITE_SECRET}"
  echo "PGBACKREST_REPO1_CIPHER_PASS=$(random 32)"
  echo "PITR_DRILL_REPO1_S3_KEY=${READ_KEY}"
  echo "PITR_DRILL_REPO1_S3_KEY_SECRET=${READ_SECRET}"
} > "$envfile"

# start_db [NAME=value...]: the Database container again, on the same volume.
# The first boot initialises it, through a temporary server that also says
# "ready": that one does not count.
FRESH=yes
start_db() {
  docker rm -f "$DB" > /dev/null 2>&1 || true
  local extra=() want=1 logs
  for pair in "$@"; do extra+=(-e "$pair"); done
  if [ "$FRESH" = yes ]; then want=2; fi
  FRESH=no
  docker run -d --name "$DB" --network "$NET" --memory 603979776 \
    -v "${VOLUME}:/var/lib/postgresql/data" --env-file "$envfile" \
    "${extra[@]+"${extra[@]}"}" "$IMAGE" > /dev/null
  for _ in $(seq 1 120); do
    logs=$(docker logs "$DB" 2>&1)
    if [ "$(grep -c "ready to accept connections" <<< "$logs")" -ge "$want" ] \
      && docker exec "$DB" pg_isready -q -h /var/run/postgresql -U trajetto -d trajetto; then
      return 0
    fi
    sleep 1
  done
  fail "o Database não ficou pronto"
}
stop_db() { docker stop -t 30 "$DB" > /dev/null; }
sql() { docker exec "$DB" psql -X -v ON_ERROR_STOP=1 -h /var/run/postgresql -U trajetto -d trajetto -Atq -c "$1"; }
pgbr() { docker exec -u postgres "$DB" pgbackrest --stanza=trajetto "$@"; }

start_db
[ "$(sql 'SHOW archive_mode')" = off ] || fail "sem PITR_ARCHIVE o arquivamento deveria estar desligado"
[ "$(sql 'SHOW shared_buffers')" = 108MB ] || fail "shared_buffers com 576 MiB: $(sql 'SHOW shared_buffers')"
pgbr stanza-create > /dev/null || fail "stanza-create no S3"
stop_db
start_db PITR_ARCHIVE=on
[ "$(sql 'SHOW archive_mode')" = on ] || fail "com PITR_ARCHIVE=on o arquivamento deveria ligar"
pgbr check > /dev/null || fail "pgbackrest check no S3"
ok "stanza-create com o arquivamento desligado, depois ligado, e check no S3"

docker exec "$DB" trajetto-backup full > "${WORK}/full.json" || fail "trajetto-backup full no S3"
grep -q '^{"result":"ok","type":"full"' "${WORK}/full.json" || fail "trajetto-backup full sem o resumo"

sql "CREATE TABLE _prisma_migrations (id varchar(36) PRIMARY KEY, migration_name varchar(255) NOT NULL, finished_at timestamptz, rolled_back_at timestamptz)"
sql "INSERT INTO _prisma_migrations VALUES ('1', '20261115130000_ops_sample', now(), NULL)"
sql "CREATE TABLE ops_sample (id text PRIMARY KEY, ts timestamp(3) NOT NULL, role text NOT NULL)"
sql "CREATE TABLE business (id text PRIMARY KEY, batch text NOT NULL)"
sql "INSERT INTO business VALUES ('b1', 'first'), ('b2', 'first')"
sql "INSERT INTO ops_sample VALUES ('m1', now() AT TIME ZONE 'UTC', 'cluster')"
sleep 2
target=$(sql "SELECT clock_timestamp()")
sleep 2
sql "INSERT INTO business VALUES ('b3', 'second'), ('b4', 'second'), ('b5', 'second')"
segment=$(sql "SELECT pg_walfile_name(pg_switch_wal())")
archived=""
for _ in $(seq 1 120); do
  archived=$(sql "SELECT coalesce(last_archived_wal, '') FROM pg_stat_archiver")
  if [ -n "$archived" ] && [[ ! "$archived" < "$segment" ]]; then break; fi
  sleep 1
done
[[ ! "$archived" < "$segment" ]] || fail "o segmento ${segment} não chegou ao S3"
pgbr archive-get "$segment" /tmp/proof-segment > /dev/null || fail "archive-get ${segment} do S3"
docker exec "$DB" trajetto-backup diff > "${WORK}/diff.json" || fail "trajetto-backup diff no S3"
grep -q '^{"result":"ok","type":"diff"' "${WORK}/diff.json" || fail "trajetto-backup diff sem o resumo"
ok "trajetto-backup full e diff (arquivo contínuo pela listagem do S3) e archive-get"

# The drill, exactly as the Schedule Job starts it.
docker exec "$DB" cat /usr/local/bin/trajetto-restore-drill \
  | bash -s -- --from "$DB" "--target=${target}" "--network=${NET}" > "${WORK}/drill.json" \
  || fail "trajetto-restore-drill no S3"
summary=$(grep '^{"result":"ok"' "${WORK}/drill.json") || fail "o ensaio não imprimiu o resumo"
[[ "$summary" == *'"counts":{"business":2}'* ]] \
  || fail "a restauração até ${target} deveria trazer só o primeiro lote: ${summary}"
if grep -q -e "$WRITE_SECRET" -e "$READ_SECRET" "${WORK}/drill.json" "${WORK}/full.json" "${WORK}/diff.json"; then
  fail "um segredo apareceu na saída"
fi
ok "ensaio com a chave só de leitura, até ${target}: só o primeiro lote"
echo "  ${summary}"
stop_db

echo "trajetto-postgres: prova S3 passou (TLS, uri-style path, região auto)."
