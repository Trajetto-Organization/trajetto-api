#!/bin/sh
#
# The trajetto-pgbouncer image's own test (plano-escala F4-34), run by
# `docker build --target test infra/pgbouncer` with no network, as the
# image's own user. PgBouncer starts from the entrypoint the image ships,
# once with the console logins and once with the minimal environment, and
# its console answers on the container's loopback; what the configuration
# says is read back from PgBouncer itself (SHOW CONFIG, SHOW DATABASES).
#
# The Database behind it is never reached (its name does not even resolve
# here): the auth_query against a real Postgres, SCRAM end to end and the
# transaction pooling are the E2E's infra phase (F4-38). Every branch of the
# entrypoint (defaults, warnings, refusals) is the unit test's
# (tests/unitaires/lifecycle/pgbouncer-image.test.ts).
set -eu

LOG=/tmp/pgbouncer-test.log
CONF_DIR=/etc/pgbouncer
# The Dockerfile's HEALTHCHECK, word for word (the unit test compares them).
HEALTHCHECK='pg_isready -q -h 127.0.0.1 -p 6432 -d pgbouncer -U pgbouncer_stats -t 3'

fail() {
  printf 'FALHOU: %s\n' "$*" >&2
  [ ! -f "$LOG" ] || sed 's/^/  pgbouncer: /' "$LOG" >&2
  exit 1
}
ok() { printf 'ok: %s\n' "$*"; }

random_password() { od -An -N24 -tx1 /dev/urandom | tr -d ' \n'; }
AUTH=$(random_password)
ADMIN=$(random_password)
STATS=$(random_password)

pid=
# start VAR=value...: the entrypoint with only these variables (and PATH),
# until the HEALTHCHECK passes.
start() {
  env -i PATH="$PATH" HOME=/var/lib/pgbouncer "$@" \
    trajetto-pgbouncer-entrypoint.sh pgbouncer > "$LOG" 2>&1 &
  pid=$!
  tries=0
  # Word splitting on purpose: the command line, as Docker runs it.
  # shellcheck disable=SC2086
  until $HEALTHCHECK; do
    kill -0 "$pid" 2> /dev/null || fail "o PgBouncer saiu na partida"
    tries=$((tries + 1))
    [ "$tries" -lt 50 ] || fail "o HEALTHCHECK não passou em 10 s"
    sleep 0.2
  done
}

# SIGTERM, what Swarm sends: with no client left, PgBouncer exits at once
# and with 0 (SHUTDOWN WAIT_FOR_CLIENTS).
stop() {
  kill -TERM "$pid"
  tries=0
  while kill -0 "$pid" 2> /dev/null; do
    tries=$((tries + 1))
    [ "$tries" -lt 50 ] || fail "o PgBouncer não saiu em 10 s depois do SIGTERM"
    sleep 0.2
  done
  status=0
  wait "$pid" || status=$?
  [ "$status" -eq 0 ] || fail "o PgBouncer saiu com $status depois do SIGTERM"
}

# console USER PASSWORD SQL: one statement on the console database, the
# header line first, columns separated by |.
console() {
  PGPASSWORD=$2 psql -X -q -A -F '|' -P footer=off \
    -h 127.0.0.1 -p 6432 -U "$1" -d pgbouncer -c "$3"
}

# value TABLE ROW COLUMN: one cell of a SHOW, read by the stats login.
value() {
  console pgbouncer_stats "$STATS" "SHOW $1" |
    awk -F'|' -v row="$2" -v col="$3" '
      NR == 1 { for (i = 1; i <= NF; i++) if ($i == col) c = i; next }
      $1 == row { print $c; found = 1 }
      END { exit !(found && c) }
    '
}

expect() {
  got=$(value "$1" "$2" "$3") || fail "SHOW $1 sem a linha $2 ou a coluna $3"
  [ "$got" = "$4" ] || fail "SHOW $1: $2.$3 = '$got', esperado '$4'"
}

# --- with the console logins ---------------------------------------------------
start PGBOUNCER_PRIMARY_HOST=primary.invalid \
  PGBOUNCER_AUTH_PASSWORD="$AUTH" \
  PGBOUNCER_ADMIN_PASSWORD="$ADMIN" \
  PGBOUNCER_STATS_PASSWORD="$STATS"
ok "sobe e passa no HEALTHCHECK"

version=$(console pgbouncer_stats "$STATS" "SHOW VERSION" | sed -n 2p)
[ "$version" = "PgBouncer ${PGBOUNCER_VERSION}" ] ||
  fail "SHOW VERSION: '$version', esperado 'PgBouncer ${PGBOUNCER_VERSION}'"
ok "PgBouncer ${PGBOUNCER_VERSION}"

while read -r key want; do
  expect CONFIG "$key" value "$want"
done << 'EOF'
listen_port 6432
pool_mode transaction
auth_type hba
auth_user pgbouncer_auth
auth_query SELECT * FROM pgbouncer.user_lookup($1)
max_client_conn 2000
default_pool_size 20
max_db_connections 60
query_wait_timeout 5
server_lifetime 3600
ignore_startup_parameters extra_float_digits
admin_users pgbouncer_admin
stats_users pgbouncer_stats
log_connections 0
log_disconnections 0
log_pooler_errors 1
EOF
expect CONFIG unix_socket_dir value ""
ok "SHOW CONFIG com a configuração do plano"

expect DATABASES trajetto host primary.invalid
expect DATABASES trajetto port 5432
expect DATABASES trajetto database trajetto
expect DATABASES trajetto pool_size 20
expect DATABASES trajetto max_connections 60
expect DATABASES trajetto_probe database trajetto
expect DATABASES trajetto_probe pool_size 2
expect DATABASES trajetto_probe max_connections 2
databases=$(console pgbouncer_stats "$STATS" "SHOW DATABASES" |
  awk -F'|' 'NR > 1 { print $1 }' | sort | tr '\n' ' ')
[ "$databases" = "pgbouncer trajetto trajetto_probe " ] ||
  fail "bancos além do console, do trajetto e do alias: $databases"
ok "só trajetto e trajetto_probe (pool de 2) atrás do console"

console pgbouncer_stats "$STATS" "PAUSE trajetto" > /tmp/out 2>&1 &&
  fail "o login de estatística pausou um banco"
grep -q "admin access needed" /tmp/out || fail "PAUSE pelo login de estatística: $(cat /tmp/out)"
console pgbouncer_admin "$ADMIN" "PAUSE trajetto" > /dev/null ||
  fail "o login de administração não pausou pelo 127.0.0.1"
console pgbouncer_admin "$ADMIN" "RESUME trajetto" > /dev/null ||
  fail "o login de administração não retomou pelo 127.0.0.1"
ok "PAUSE e RESUME só pelo login de administração"

console pgbouncer_stats "wrong-$STATS" "SHOW VERSION" > /dev/null 2>&1 &&
  fail "senha errada entrou no console"
ok "senha errada não entra"

[ "$(stat -c '%a %U' "$CONF_DIR/userlist.txt")" = "600 pgbouncer" ] ||
  fail "userlist.txt legível por outro usuário: $(stat -c '%a %U' "$CONF_DIR/userlist.txt")"
if tr '\0' '\n' < "/proc/$pid/environ" | grep -q PASSWORD; then
  fail "uma senha ficou no ambiente do PgBouncer"
fi
ok "o auth_file só do usuário da imagem, e nenhuma senha no ambiente do processo"

stop
ok "SIGTERM sem cliente: sai na hora, com 0"

# --- the minimal environment ---------------------------------------------------
start PGBOUNCER_PRIMARY_HOST=primary.invalid PGBOUNCER_AUTH_PASSWORD="$AUTH"
for _ in 1 2 3; do
  # shellcheck disable=SC2086
  $HEALTHCHECK || fail "o HEALTHCHECK falhou com as envs mínimas"
done
# The HEALTHCHECK runs every 10 s for the life of the container: it must
# not leave a line in PgBouncer's log.
if grep -E 'WARNING|ERROR|FATAL' "$LOG"; then
  fail "o HEALTHCHECK deixou erro no log"
fi
grep -qx 'admin_users = ' "$CONF_DIR/pgbouncer.ini" ||
  fail "admin_users com login sem PGBOUNCER_ADMIN_PASSWORD"
grep -q '^"pgbouncer_admin"' "$CONF_DIR/userlist.txt" &&
  fail "pgbouncer_admin no auth_file sem PGBOUNCER_ADMIN_PASSWORD"
console pgbouncer_admin "$ADMIN" "SHOW VERSION" > /dev/null 2>&1 &&
  fail "o console de administração abriu sem PGBOUNCER_ADMIN_PASSWORD"
console pgbouncer_stats "$STATS" "SHOW VERSION" > /dev/null 2>&1 &&
  fail "o login de estatística abriu sem PGBOUNCER_STATS_PASSWORD"
stop
ok "sobe com as envs mínimas, o console fechado e o HEALTHCHECK em silêncio"

# --- refuses without where to go -----------------------------------------------
status=0
env -i PATH="$PATH" PGBOUNCER_AUTH_PASSWORD="$AUTH" \
  trajetto-pgbouncer-entrypoint.sh pgbouncer > "$LOG" 2>&1 || status=$?
[ "$status" -eq 64 ] || fail "sem PGBOUNCER_PRIMARY_HOST saiu com $status, esperado 64"
# shellcheck disable=SC2086
if $HEALTHCHECK; then fail "um PgBouncer ficou de pé sem PGBOUNCER_PRIMARY_HOST"; fi
ok "sem PGBOUNCER_PRIMARY_HOST recusa (64) e não sobe"

printf 'trajetto-pgbouncer: todos os testes passaram\n'
