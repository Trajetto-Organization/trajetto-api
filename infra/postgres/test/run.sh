#!/usr/bin/env bash
#
# The `test` stage of infra/postgres/Dockerfile (plano-escala F1-01):
# `docker build --target test infra/postgres` runs this inside the image it
# ships in, offline (`RUN --network=none`), as root, the way a Swarm task
# starts the container. Every server here is started through
# trajetto-entrypoint.sh, so what passes is the wrapper production runs:
#
#   - the tools: pgBackRest at the Dockerfile's version, linked against what
#     the image has; postgres and pg_dump 16.x; no postgresql package;
#   - a fresh volume initialised by the official entrypoint, collated by
#     libc (musl) like every database the stock image created;
#   - the static parameters, archive_mode=off without PITR_ARCHIVE, the
#     commit in trajetto.image_revision, auto_explain only on request;
#   - the memory table of the plan, read back with SHOW, for 576, 768, 1792,
#     2048, 3072 and 12288 MiB;
#   - an extra argument (the Database's Args) that wins over the default and
#     keeps every other flag, with and without a leading `postgres`;
#   - bad environment values falling back instead of stopping the server;
#   - a PITR round trip on an encrypted posix repository: stanza-create with
#     archiving off, then on, check, full backup, archive-get, and a restore
#     to a time between two batches of rows that brings back the first only;
#   - trajetto-backup and trajetto-restore-drill (F1-02) for real, pinging
#     a local listener: a diff with no hole pings success; the drill
#     restores the newest backup, starts it with archive_mode=off and reads
#     _prisma_migrations, the counts and the ops_sample marker;
#   - the archive queue cap: with the repository gone and a tiny cap,
#     archive-push reports the segments archived and drops them, pg_wal stops
#     growing, and the log says so; with the repository back, the next diff
#     finds that hole and pings /fail with 'archive-gap', and a full reports
#     it and starts a clean window.
set -Eeuo pipefail

: "${PGBACKREST_VERSION:?PGBACKREST_VERSION ausente (ARG do Dockerfile)}"

WORK=/tmp/trajetto-test
SOCK=/var/run/postgresql
RUNS=0
PID=""
LOG=""

export POSTGRES_USER=trajetto
export POSTGRES_DB=trajetto
POSTGRES_PASSWORD=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
export POSTGRES_PASSWORD
export PGDATA="${WORK}/data"

fail() {
  echo "FALHOU: $*" >&2
  if [ -n "$LOG" ] && [ -f "$LOG" ]; then
    echo "--- últimas linhas de ${LOG} ---" >&2
    tail -n 80 "$LOG" >&2
  fi
  exit 1
}
trap 'fail "comando falhou na linha ${LINENO}"' ERR

ok() { echo "ok - $*"; }

mkdir -p "$WORK"
chmod 0777 "$WORK"

# --- the tools -----------------------------------------------------------------

[ "$(pgbackrest version)" = "pgBackRest ${PGBACKREST_VERSION}" ] \
  || fail "pgbackrest version: $(pgbackrest version)"
if ldd /usr/local/bin/pgbackrest 2>&1 | grep -Eqi 'not found|error'; then
  ldd /usr/local/bin/pgbackrest >&2 || true
  fail "o pgbackrest não acha uma biblioteca"
fi
[ "$(command -v postgres)" = /usr/local/bin/postgres ] || fail "postgres fora de /usr/local/bin"
[ "$(command -v pg_dump)" = /usr/local/bin/pg_dump ] || fail "pg_dump fora de /usr/local/bin"
postgres --version | grep -Eq '^postgres \(PostgreSQL\) 16\.' || fail "postgres não é 16.x: $(postgres --version)"
pg_dump --version | grep -Eq '^pg_dump \(PostgreSQL\) 16\.' || fail "pg_dump não é 16.x: $(pg_dump --version)"
# A second server, or a second libpq, beside the image's own.
if apk info 2> /dev/null | grep -Eq '^(postgresql|libpq)'; then
  fail "há um pacote postgresql/libpq do apk na imagem: $(apk info | grep -E '^(postgresql|libpq)' | tr '\n' ' ')"
fi
ok "pgBackRest ${PGBACKREST_VERSION}, postgres e pg_dump 16.x, sem pacote postgresql"

# --- a server through the wrapper ----------------------------------------------

ARGS=(postgres)

# start [NAME=value...]: the wrapper with the image's environment plus these.
start() {
  RUNS=$((RUNS + 1))
  LOG="${WORK}/server-${RUNS}.log"
  env "$@" trajetto-entrypoint.sh "${ARGS[@]}" > "$LOG" 2>&1 &
  PID=$!
  for _ in $(seq 1 240); do
    # The temporary server of the first boot listens on the socket too: ready
    # is the final server, the process started above (every step execs).
    if [ -f "${PGDATA}/postmaster.pid" ] \
      && [ "$(head -n 1 "${PGDATA}/postmaster.pid")" = "$PID" ] \
      && pg_isready -q -h "$SOCK" -U trajetto -d trajetto; then
      return 0
    fi
    kill -0 "$PID" 2> /dev/null || fail "o servidor saiu ao subir"
    sleep 0.25
  done
  fail "o servidor não ficou pronto em 60 s"
}

stop() {
  kill -INT "$PID"
  wait "$PID" || true
  PID=""
}

sql() { psql -X -v ON_ERROR_STOP=1 -h "$SOCK" -U trajetto -d trajetto -Atq -c "$1"; }

expect() {
  local got
  got=$(sql "SHOW $1")
  [ "$got" = "$2" ] || fail "$1 = '${got}', esperado '$2'"
}

# In MiB, whatever unit SHOW picks (1024MB shows as 1GB).
expect_mb() {
  local got
  got=$(sql "SELECT pg_size_bytes(current_setting('$1')) / 1048576")
  [ "$got" = "$2" ] || fail "$1 = ${got} MB, esperado $2 MB (limite ${3:-?})"
}

# --- a fresh volume, the defaults and the static parameters --------------------

start
grep -q "PostgreSQL init process complete" "$LOG" || fail "o entrypoint oficial não inicializou o volume"
[ "$(sql "SELECT datcollate || '|' || datctype || '|' || datlocprovider::text FROM pg_database WHERE datname = 'trajetto'")" = "en_US.utf8|en_US.utf8|c" ] \
  || fail "colação do banco novo: $(sql "SELECT datcollate, datctype, datlocprovider FROM pg_database WHERE datname = 'trajetto'")"
expect archive_mode off
expect shared_buffers 128MB
expect max_connections 200
expect max_wal_size 8GB
expect max_slot_wal_keep_size 4GB
expect commit_delay 0
expect commit_siblings 5
expect synchronous_commit on
expect jit off
expect max_parallel_workers_per_gather 0
expect max_parallel_maintenance_workers 0
expect hash_mem_multiplier 2
expect log_parameter_max_length 0
expect wal_level replica
expect wal_compression lz4
expect shared_preload_libraries pg_stat_statements
expect compute_query_id on
expect pg_stat_statements.track_utility off
expect trajetto.image_revision dev
sql "CREATE EXTENSION IF NOT EXISTS pg_stat_statements" > /dev/null
[ "$(sql "SELECT count(*) > 0 FROM pg_stat_statements")" = t ] || fail "pg_stat_statements não lê"
grep -q "sem POSTGRES_MEMORY_LIMIT_MB" "$LOG" || fail "o wrapper não disse que a memória ficou no padrão"
stop
ok "volume novo (en_US.utf8, libc), parâmetros estáticos, archive_mode=off, pgss lendo"

# --- the memory table -----------------------------------------------------------

# limit shared_buffers effective_cache_size maintenance_work_mem
# autovacuum_work_mem work_mem autovacuum_max_workers
while read -r limit sb ecs mwm avwm wm workers; do
  start "POSTGRES_MEMORY_LIMIT_MB=${limit}"
  expect_mb shared_buffers "$sb" "$limit"
  expect_mb effective_cache_size "$ecs" "$limit"
  expect_mb maintenance_work_mem "$mwm" "$limit"
  expect_mb autovacuum_work_mem "$avwm" "$limit"
  expect_mb work_mem "$wm" "$limit"
  expect autovacuum_max_workers "$workers"
  stop
done << 'TABLE'
576 108 302 54 27 4 3
768 144 403 72 36 4 3
1792 384 1075 192 96 11 3
2048 448 1254 224 112 13 5
3072 704 1971 352 176 21 5
12288 3008 8422 1024 256 64 5
TABLE
ok "memória derivada do teto confere com SHOW nos seis limites"

# --- the environment's knobs -----------------------------------------------------

start POSTGRES_MEMORY_LIMIT_MB=576 POSTGRES_EXPECTED_ACTIVE_CONNECTIONS=4 \
  POSTGRES_MAX_CONNECTIONS=120 POSTGRES_MAX_WAL_SIZE=1GB \
  POSTGRES_MAX_SLOT_WAL_KEEP_SIZE=2GB POSTGRES_COMMIT_DELAY_US=200 \
  POSTGRES_COMMIT_SIBLINGS=8 POSTGRES_AUTO_EXPLAIN=on APP_COMMIT_SHA=0123abc
expect_mb work_mem 16 "576 com 4 conexões ativas"
expect max_connections 120
expect max_wal_size 1GB
expect max_slot_wal_keep_size 2GB
expect commit_delay 200
expect commit_siblings 8
expect shared_preload_libraries "pg_stat_statements,auto_explain"
expect trajetto.image_revision 0123abc
stop
ok "conexões, WAL, slot, commit_delay, auto_explain e revisão por env"

start POSTGRES_MEMORY_LIMIT_MB=lots POSTGRES_MAX_WAL_SIZE=-1 \
  POSTGRES_MAX_SLOT_WAL_KEEP_SIZE=-1 POSTGRES_MAX_CONNECTIONS=0 PITR_ARCHIVE=yes
expect shared_buffers 128MB
expect max_wal_size 8GB
expect max_slot_wal_keep_size 4GB
expect max_connections 200
expect archive_mode off
[ "$(grep -c 'AVISO' "$LOG")" -ge 5 ] || fail "valores inválidos sem AVISO no log"
stop
ok "valores inválidos caem no padrão, com aviso, e o banco sobe"

ARGS=(postgres -c work_mem=7MB -c shared_buffers=96MB)
start POSTGRES_MEMORY_LIMIT_MB=576
expect work_mem 7MB
expect shared_buffers 96MB
expect_mb effective_cache_size 302 576
expect jit off
stop
# As the Database's Args arrive when they are set: flags only.
ARGS=(-c work_mem=9MB)
start POSTGRES_MEMORY_LIMIT_MB=576
expect work_mem 9MB
expect_mb shared_buffers 108 576
expect archive_mode off
stop
ARGS=(postgres)
ok "um arg extra ganha do padrão e mantém os outros"

# --- PITR round trip on an encrypted posix repository ----------------------------

REPO="${WORK}/repo"
install -d -o postgres -g postgres -m 0750 "$REPO"
export PGBACKREST_REPO1_TYPE=posix
export PGBACKREST_REPO1_PATH="$REPO"
PGBACKREST_REPO1_CIPHER_PASS=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
export PGBACKREST_REPO1_CIPHER_PASS
pgbr() { gosu postgres pgbackrest --stanza=trajetto "$@"; }

# The F1a order: the repository first, archiving off; stanza-create; then on.
start
expect archive_mode off
grep -q '^pg1-user=trajetto$' /etc/pgbackrest/conf.d/runtime.conf || fail "runtime.conf sem pg1-user"
grep -q '^archive-push-queue-max=4GB$' /etc/pgbackrest/conf.d/runtime.conf || fail "runtime.conf sem a fila padrão"
pgbr stanza-create > "${WORK}/stanza.log" 2>&1 || {
  LOG="${WORK}/stanza.log"
  fail "stanza-create"
}
stop

start PITR_ARCHIVE=on
expect archive_mode on
expect archive_command "pgbackrest --stanza=trajetto archive-push %p"
expect archive_timeout 1min
pgbr check > "${WORK}/check.log" 2>&1 || {
  LOG="${WORK}/check.log"
  fail "pgbackrest check"
}
pgbr backup --type=full > "${WORK}/backup.log" 2>&1 || {
  LOG="${WORK}/backup.log"
  fail "pgbackrest backup --type=full"
}
sql "CREATE TABLE pitr_probe (n int PRIMARY KEY, batch text NOT NULL)"
sql "INSERT INTO pitr_probe SELECT g, 'first' FROM generate_series(1, 100) g"
sleep 1.2
target=$(sql "SELECT clock_timestamp()")
sleep 1.2
sql "INSERT INTO pitr_probe SELECT g, 'second' FROM generate_series(101, 200) g"
segment=$(sql "SELECT pg_walfile_name(pg_switch_wal())")
for _ in $(seq 1 120); do
  archived=$(sql "SELECT coalesce(last_archived_wal, '') FROM pg_stat_archiver")
  if [ -n "$archived" ] && [[ ! "$archived" < "$segment" ]]; then break; fi
  sleep 0.5
done
[[ ! "$archived" < "$segment" ]] || fail "o segmento ${segment} não foi arquivado (último: ${archived})"
pgbr archive-get "$segment" "${WORK}/fetched-wal" > /dev/null 2>&1 || fail "archive-get ${segment}"
[ "$(stat -c %s "${WORK}/fetched-wal")" = 16777216 ] || fail "o segmento baixado não tem 16 MiB"
pgbr info > "${WORK}/info.txt"
grep -q 'full backup' "${WORK}/info.txt" || fail "pgbackrest info sem o full"
stop

RESTORED="${WORK}/restored"
install -d -o postgres -g postgres -m 0700 "$RESTORED"
pgbr --pg1-path="$RESTORED" --type=time "--target=${target}" \
  --target-action=promote --archive-mode=off restore > "${WORK}/restore.log" 2>&1 || {
  LOG="${WORK}/restore.log"
  fail "pgbackrest restore --type=time"
}
RSOCK="${WORK}/restored-socket"
install -d -o postgres -g postgres -m 0700 "$RSOCK"
LOG="${WORK}/restored.log"
# Through the wrapper too, as the drill does: recovery refuses a
# max_connections (or max_worker_processes...) below the primary's, so the
# copy must start with the same parameters, plus the drill's own on top.
env PGDATA="$RESTORED" trajetto-entrypoint.sh postgres -c archive_mode=off \
  -c listen_addresses= -c port=5433 -c "unix_socket_directories=${RSOCK}" \
  -c shared_buffers=128MB > "$LOG" 2>&1 &
PID=$!
promoted=""
for _ in $(seq 1 240); do
  if pg_isready -q -h "$RSOCK" -p 5433 -U trajetto -d trajetto \
    && [ "$(psql -X -h "$RSOCK" -p 5433 -U trajetto -d trajetto -Atqc 'SELECT pg_is_in_recovery()')" = f ]; then
    promoted=yes
    break
  fi
  kill -0 "$PID" 2> /dev/null || fail "a cópia restaurada saiu ao subir"
  sleep 0.25
done
[ -n "$promoted" ] || fail "a cópia restaurada não terminou a recuperação"
rows=$(psql -X -h "$RSOCK" -p 5433 -U trajetto -d trajetto -Atqc "SELECT string_agg(DISTINCT batch, ',') || ':' || count(*) FROM pitr_probe")
[ "$rows" = "first:100" ] || fail "a restauração até ${target} trouxe '${rows}', esperado só o primeiro lote (first:100)"
[ "$(psql -X -h "$RSOCK" -p 5433 -U trajetto -d trajetto -Atqc 'SHOW archive_mode')" = off ] || fail "a cópia restaurada subiu arquivando"
stop
ok "PITR: stanza, check, full, archive-get e restore até ${target} só com o primeiro lote"

# --- trajetto-backup and trajetto-restore-drill, for real ---------------------------

# healthchecks.io's stand-in: every request, path and body, one per line.
export PINGS_LOG="${WORK}/pings.log"
: > "$PINGS_LOG"
chmod 0666 "$PINGS_LOG"
cat > "${WORK}/ping-handler.sh" << 'HANDLER'
#!/bin/sh
read -r _ path _
length=0
while IFS= read -r header; do
  header=$(printf '%s' "$header" | tr -d '\r')
  [ -n "$header" ] || break
  case "$header" in
    [Cc]ontent-[Ll]ength:*) length=$(echo "${header#*:}" | tr -d ' ') ;;
  esac
done
body=""
if [ "$length" -gt 0 ]; then body=$(head -c "$length"); fi
printf '%s %s\n' "$path" "$body" >> "$PINGS_LOG"
printf 'HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nOK'
HANDLER
chmod 0755 "${WORK}/ping-handler.sh"
nc -lk -s 127.0.0.1 -p 18080 -e "${WORK}/ping-handler.sh" &
LISTENER=$!
trap 'kill "$LISTENER" 2> /dev/null || true' EXIT
export PITR_BACKUP_DIFF_PING_URL=http://127.0.0.1:18080/backup-diff
export PITR_BACKUP_FULL_PING_URL=http://127.0.0.1:18080/backup-full
export PITR_DRILL_PING_URL=http://127.0.0.1:18080/drill
pinged() { grep -c "^$1 " "$PINGS_LOG" || true; }

start PITR_ARCHIVE=on
# What the drill reads: the migrations' table and the heartbeat's marker,
# as the API creates them.
sql "CREATE TABLE _prisma_migrations (id varchar(36) PRIMARY KEY, migration_name varchar(255) NOT NULL, finished_at timestamptz, rolled_back_at timestamptz)"
sql "INSERT INTO _prisma_migrations VALUES ('1', '20261115130000_ops_sample', now(), NULL)"
sql "CREATE TABLE ops_sample (id text PRIMARY KEY, ts timestamp(3) NOT NULL, role text NOT NULL)"
sql "INSERT INTO ops_sample VALUES ('m1', now() AT TIME ZONE 'UTC', 'cluster')"
sql "CREATE TABLE business (id text PRIMARY KEY)"
sql "INSERT INTO business VALUES ('b1'), ('b2')"
LOG="${WORK}/backup-diff.log"
trajetto-backup diff > "$LOG" 2>&1 || fail "trajetto-backup diff sem buraco não passou"
grep -q '^{"result":"ok","type":"diff"' "$LOG" || fail "trajetto-backup diff sem o resumo"
[ "$(pinged /backup-diff/start)" = 1 ] || fail "trajetto-backup não pingou /start"
grep -q '^/backup-diff {"result":"ok","type":"diff"' "$PINGS_LOG" || fail "trajetto-backup não pingou o sucesso"
if grep -q "$PGBACKREST_REPO1_CIPHER_PASS" "$LOG" "$PINGS_LOG"; then fail "a senha da cifra vazou"; fi
stop
ok "trajetto-backup diff: backup, check, arquivo contínuo, ping de sucesso, nenhum segredo"

printf 'MemAvailable:    8388608 kB\n' > "${WORK}/meminfo"
LOG="${WORK}/drill.log"
env PGDATA="${WORK}/drill" TRAJETTO_MEMINFO="${WORK}/meminfo" \
  trajetto-restore-drill --inside > "$LOG" 2>&1 || fail "trajetto-restore-drill --inside falhou"
summary=$(grep '^{"result":"ok"' "$LOG") || fail "o ensaio não imprimiu o resumo"
[[ "$summary" == *'"migrations":{"applied":1,"last":"20261115130000_ops_sample"}'* ]] || fail "o ensaio não leu _prisma_migrations: ${summary}"
[[ "$summary" == *'"counts":{"business":2}'* ]] || fail "o ensaio não contou as tabelas: ${summary}"
[[ "$summary" =~ \"loss_seconds\":[0-9]+, ]] || fail "o ensaio não mediu a perda: ${summary}"
[[ "$summary" =~ \"rto_seconds\":[0-9]+, ]] || fail "o ensaio não mediu o RTO: ${summary}"
grep -q '^/drill {"result":"ok"' "$PINGS_LOG" || fail "o ensaio não pingou o sucesso"
if grep -q "$PGBACKREST_REPO1_CIPHER_PASS" "$LOG" "$PINGS_LOG"; then fail "a senha da cifra vazou no ensaio"; fi
rm -rf "${WORK}/drill"
ok "trajetto-restore-drill: restaura, sobe sem arquivar, lê migrations, contagens e o marcador, e pinga"
echo "  ${summary}"

# --- the archive queue cap -------------------------------------------------------

# The repository disappears (R2 down, a revoked key): with a cap below one
# segment every archive-push drops its segment and reports success.
mv "$REPO" "${REPO}.gone"
start PITR_ARCHIVE=on PGBACKREST_ARCHIVE_PUSH_QUEUE_MAX=1MB
grep -q '^archive-push-queue-max=1MB$' /etc/pgbackrest/conf.d/runtime.conf || fail "runtime.conf sem a fila de 1MB"
before=$(sql "SELECT archived_count FROM pg_stat_archiver")
for _ in 1 2 3 4; do
  sql "INSERT INTO pitr_probe SELECT g, 'queued' FROM generate_series((SELECT max(n) + 1 FROM pitr_probe), (SELECT max(n) + 2000 FROM pitr_probe)) g"
  sql "SELECT pg_switch_wal()" > /dev/null
done
dropped=""
for _ in $(seq 1 240); do
  after=$(sql "SELECT archived_count FROM pg_stat_archiver")
  ready=$(find "${PGDATA}/pg_wal/archive_status" -name '*.ready' | wc -l)
  if [ "$after" -ge $((before + 4)) ] && [ "$ready" -eq 0 ]; then
    dropped=yes
    break
  fi
  sleep 0.25
done
[ -n "$dropped" ] || fail "com o repositório fora e a fila de 1MB, o WAL não foi descartado (arquivados ${before} → ${after}, .ready ${ready})"
grep -q "dropped WAL file" "$LOG" || fail "o log não avisa o descarte"
stop
ok "fila do arquivamento: com o repositório fora, o WAL acima do teto é descartado com aviso"

# The repository is back: the next diff must find the dropped segments.
mv "${REPO}.gone" "$REPO"
start PITR_ARCHIVE=on
LOG="${WORK}/backup-gap.log"
status=0
trajetto-backup diff > "$LOG" 2>&1 || status=$?
[ "$status" = 2 ] || fail "trajetto-backup diff com o buraco saiu com ${status}, esperado 2"
grep -q 'archive-gap' "$LOG" || fail "trajetto-backup não disse archive-gap"
grep -q '^/backup-diff/fail {"result":"fail","reason":"archive-gap"' "$PINGS_LOG" || fail "trajetto-backup não pingou /fail com archive-gap"
# The full the ping asks for: green, and the window is clean from it on.
LOG="${WORK}/backup-full.log"
trajetto-backup full > "$LOG" 2>&1 || fail "o full depois do buraco não passou"
grep -q '^/backup-full {"result":"ok","type":"full"' "$PINGS_LOG" || fail "o full não pingou o sucesso"
LOG="${WORK}/backup-after.log"
trajetto-backup diff > "$LOG" 2>&1 || fail "o diff depois do full não voltou a verde"
if grep -q '"archive_gap"' "$LOG"; then fail "o diff depois do full ainda vê o buraco"; fi
stop
ok "o buraco do descarte: o diff pinga /fail archive-gap, e o full pedido abre uma janela limpa"

echo "trajetto-postgres: todos os testes da imagem passaram."
