#!/bin/sh
#
# Entrypoint of the trajetto-pgbouncer image (plano-escala F4-34).
#
# At every start it writes PgBouncer's three files from the environment,
# then execs PgBouncer as PID 1. SIGTERM (what Swarm sends) is SHUTDOWN
# WAIT_FOR_CLIENTS since 1.23: the old task of a start-first rolling stops
# taking new clients and serves the ones it has until they leave (the
# runtime pools recycle every connection within a minute), inside the
# Application's Stop Grace Period.
#
#   pgbouncer.ini  transaction pooling for <db> and its <db>_probe alias
#                  (2 connections: the readiness never waits behind the
#                  traffic); every user's SCRAM verifier comes from the
#                  database itself, through auth_query and the closed
#                  function pgbouncer.user_lookup (infra/sql/30-pgbouncer-auth.sql),
#                  so no application password lives here;
#   userlist.txt   the auth_file: pgbouncer_auth, whose password PgBouncer
#                  needs in clear to log in and run the auth_query, and the
#                  two console logins, pgbouncer_admin (PAUSE, RESUME,
#                  KILL), only when its password is set, and pgbouncer_stats
#                  (SHOW only), always: without PGBOUNCER_STATS_PASSWORD its
#                  password is random and nobody holds it. It is there so
#                  the HEALTHCHECK's pg_isready gets an authentication
#                  request back, which PgBouncer does not log (an unknown
#                  or unlisted console login is a logged error);
#   pg_hba.conf    SCRAM for everyone; the admin console only from inside
#                  the container (127.0.0.1); no physical replication (a
#                  logical one names a database, as in Postgres, and the
#                  Database refuses it: no runtime role has REPLICATION);
#                  the three logins of this file never reach the
#                  application database.
#
# Environment (docs/variaveis-de-ambiente.md, "PgBouncer"):
#   PGBOUNCER_PRIMARY_HOST, PGBOUNCER_AUTH_PASSWORD     required
#   PGBOUNCER_DATABASE (trajetto), PGBOUNCER_PRIMARY_PORT (5432)
#   PGBOUNCER_ADMIN_PASSWORD, PGBOUNCER_STATS_PASSWORD  the console logins
#   PGBOUNCER_MAX_CLIENT_CONN (2000), PGBOUNCER_DEFAULT_POOL_SIZE (20),
#   PGBOUNCER_MAX_DB_CONNECTIONS (60)
#
# What decides where the connections go (database, host, port) or who gets
# in (the passwords) refuses to start when missing or malformed, with exit
# 64: a pooler pointed at the wrong place is worse than one that is down,
# and a start-first rolling keeps the old task while the new one fails. A
# bad number falls back to its default with a warning, as in the Postgres
# image. No password is ever printed, and none is left in the environment
# PgBouncer inherits.
#
# Any first argument other than `pgbouncer` or a flag runs as given (sh,
# psql...); flags go to PgBouncer, before the configuration file.
set -eu

CONF_DIR=${TRAJETTO_PGBOUNCER_CONF_DIR:-/etc/pgbouncer}

if [ "$#" -gt 0 ] && [ "$1" != "pgbouncer" ] && [ "${1#-}" = "$1" ]; then
  exec "$@"
fi
if [ "${1:-}" = "pgbouncer" ]; then shift; fi

say() { printf 'trajetto-pgbouncer: %s\n' "$*" >&2; }
warn() { printf 'trajetto-pgbouncer: AVISO: %s\n' "$*" >&2; }
refuse() {
  printf 'trajetto-pgbouncer: ERRO: %s\n' "$*" >&2
  exit 64
}

# A plain positive integer: digits only, no sign, no leading zero (which a
# shell would read as octal), at most 7 digits.
is_count() {
  case $1 in
    '' | *[!0-9]* | 0*) return 1 ;;
  esac
  [ "${#1}" -le 7 ]
}

# int_env NAME DEFAULT MIN MAX: the variable when it is an integer within
# [MIN, MAX]; otherwise its default, with a warning when it was set.
int_env() {
  eval "raw=\${$1:-}"
  if [ -z "$raw" ]; then
    printf '%s' "$2"
    return
  fi
  if is_count "$raw" && [ "$raw" -ge "$3" ] && [ "$raw" -le "$4" ]; then
    printf '%s' "$raw"
    return
  fi
  warn "$1=$raw inválido (inteiro de $3 a $4); vale o padrão $2"
  printf '%s' "$2"
}

newline='
'
carriage_return=$(printf '\r')

# check_password NAME: a password the auth_file can hold, on one line, at
# least 16 characters (`openssl rand -hex 32` gives 64). The value itself
# is never printed.
check_password() {
  eval "value=\${$1:-}"
  case $value in
    *"$newline"* | *"$carriage_return"*)
      refuse "$1 tem quebra de linha: digite a senha numa linha só"
      ;;
  esac
  [ "${#value}" -ge 16 ] ||
    refuse "$1 com menos de 16 caracteres: gere com openssl rand -hex 32"
}

# The auth_file line of a login: both fields quoted, a double quote inside
# the password doubled (PgBouncer's escape).
auth_line() {
  escaped=$(printf '%s' "$2" | sed 's/"/""/g')
  printf '"%s" "%s"\n' "$1" "$escaped"
}

# --- where the connections go ----------------------------------------------
DATABASE=${PGBOUNCER_DATABASE:-trajetto}
case $DATABASE in
  '' | *[!a-z0-9_]* | [0-9]*)
    refuse "PGBOUNCER_DATABASE=$DATABASE inválido: letras minúsculas, dígitos e _, começando por letra ou _"
    ;;
  pgbouncer | all | replication | sameuser | samerole | samegroup)
    refuse "PGBOUNCER_DATABASE=$DATABASE é um nome reservado do PgBouncer ou do pg_hba"
    ;;
esac
[ "${#DATABASE}" -le 57 ] ||
  refuse "PGBOUNCER_DATABASE com mais de 57 caracteres: o alias ${DATABASE}_probe passaria dos 63 do Postgres"
PROBE=${DATABASE}_probe

HOST=${PGBOUNCER_PRIMARY_HOST:-}
[ -n "$HOST" ] ||
  refuse "sem PGBOUNCER_PRIMARY_HOST: o App Name do Database (trajetto-postgres-<ambiente>)"
case $HOST in
  *[!A-Za-z0-9._:-]* | [.:-]*)
    refuse "PGBOUNCER_PRIMARY_HOST=$HOST inválido: um nome ou um endereço só"
    ;;
esac
[ "${#HOST}" -le 253 ] || refuse "PGBOUNCER_PRIMARY_HOST com mais de 253 caracteres"

PORT=${PGBOUNCER_PRIMARY_PORT:-5432}
if ! is_count "$PORT" || [ "$PORT" -gt 65535 ]; then
  refuse "PGBOUNCER_PRIMARY_PORT=$PORT inválido: uma porta de 1 a 65535"
fi

# --- who gets in --------------------------------------------------------------
[ -n "${PGBOUNCER_AUTH_PASSWORD:-}" ] ||
  refuse "sem PGBOUNCER_AUTH_PASSWORD: a senha do login pgbouncer_auth (\\password pgbouncer_auth no psql do Database)"
check_password PGBOUNCER_AUTH_PASSWORD
# PgBouncer reads an md5 or SCRAM value as a hash, and with a hash it
# cannot log in to the Database to run the auth_query.
case $PGBOUNCER_AUTH_PASSWORD in
  SCRAM-SHA-256\$*)
    refuse "PGBOUNCER_AUTH_PASSWORD é um verificador SCRAM: o PgBouncer precisa da senha em claro"
    ;;
  md5*)
    [ "${#PGBOUNCER_AUTH_PASSWORD}" -ne 35 ] ||
      refuse "PGBOUNCER_AUTH_PASSWORD parece um hash md5: o PgBouncer precisa da senha em claro"
    ;;
esac

ADMIN_PASSWORD=${PGBOUNCER_ADMIN_PASSWORD:-}
STATS_PASSWORD=${PGBOUNCER_STATS_PASSWORD:-}
[ -z "$ADMIN_PASSWORD" ] || check_password PGBOUNCER_ADMIN_PASSWORD
[ -z "$STATS_PASSWORD" ] || check_password PGBOUNCER_STATS_PASSWORD
# The stats password goes into the API's Environment; the admin one stays
# with the owner. The same value in both would hand the API the console
# that pauses every database.
if [ -n "$ADMIN_PASSWORD" ] && [ "$ADMIN_PASSWORD" = "$STATS_PASSWORD" ]; then
  refuse "PGBOUNCER_ADMIN_PASSWORD igual à PGBOUNCER_STATS_PASSWORD: a de estatística vai para a API, a de administração fica só com o dono"
fi

# --- how much -------------------------------------------------------------------
MAX_CLIENT_CONN=$(int_env PGBOUNCER_MAX_CLIENT_CONN 2000 10 100000)
DEFAULT_POOL_SIZE=$(int_env PGBOUNCER_DEFAULT_POOL_SIZE 20 1 1000)
MAX_DB_CONNECTIONS=$(int_env PGBOUNCER_MAX_DB_CONNECTIONS 60 1 5000)

# Each client and each server connection is a file descriptor. Raise the
# soft limit to the hard one (allowed to any user); below what the limits
# above can open, accept() fails with "Too many open files" under load.
hard=$(ulimit -Hn 2> /dev/null || true)
case $hard in
  '' | *[!0-9]*) ;;
  *) ulimit -n "$hard" 2> /dev/null || true ;;
esac
soft=$(ulimit -n 2> /dev/null || true)
need=$((MAX_CLIENT_CONN + MAX_DB_CONNECTIONS + 2 + 32))
case $soft in
  '' | *[!0-9]*) ;;
  *)
    [ "$soft" -ge "$need" ] ||
      warn "limite de arquivos abertos $soft, abaixo dos $need que max_client_conn e max_db_connections pedem"
    ;;
esac

ADMIN_USERS=pgbouncer_admin
ADMIN_STATE=aberto
if [ -z "$ADMIN_PASSWORD" ]; then
  ADMIN_USERS=
  ADMIN_STATE=fechado
  warn "sem PGBOUNCER_ADMIN_PASSWORD: o console de administração fica fechado (sem PAUSE nem RESUME)"
fi
STATS_STATE=aberto
if [ -z "$STATS_PASSWORD" ]; then
  STATS_STATE=fechado
  warn "sem PGBOUNCER_STATS_PASSWORD: o login de estatística fica com uma senha aleatória que ninguém tem (sem SHOW para as métricas)"
fi

# --- the files ----------------------------------------------------------------------
umask 077
mkdir -p "$CONF_DIR"

{
  auth_line pgbouncer_auth "$PGBOUNCER_AUTH_PASSWORD"
  [ -z "$ADMIN_PASSWORD" ] || auth_line pgbouncer_admin "$ADMIN_PASSWORD"
  auth_line pgbouncer_stats \
    "${STATS_PASSWORD:-$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')}"
} > "$CONF_DIR/userlist.txt"

# First match wins; a connection no line matches is refused.
cat > "$CONF_DIR/pg_hba.conf" << EOF
# Written by trajetto-pgbouncer-entrypoint.sh at every start.
# TYPE  DATABASE  USER  ADDRESS  METHOD
host replication all all reject
host pgbouncer pgbouncer_admin 127.0.0.1/32 scram-sha-256
host pgbouncer pgbouncer_stats all scram-sha-256
host all pgbouncer_auth,pgbouncer_admin,pgbouncer_stats all reject
host $DATABASE,$PROBE all all scram-sha-256
EOF

cat > "$CONF_DIR/pgbouncer.ini" << EOF
; Written by trajetto-pgbouncer-entrypoint.sh at every start, from the
; environment: an edit here is lost on the next start.

[databases]
$DATABASE = host=$HOST port=$PORT dbname=$DATABASE
$PROBE = host=$HOST port=$PORT dbname=$DATABASE pool_size=2 max_db_connections=2

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
unix_socket_dir =
pool_mode = transaction
max_client_conn = $MAX_CLIENT_CONN
default_pool_size = $DEFAULT_POOL_SIZE
max_db_connections = $MAX_DB_CONNECTIONS
query_wait_timeout = 5
server_lifetime = 3600
ignore_startup_parameters = extra_float_digits
auth_type = hba
auth_hba_file = $CONF_DIR/pg_hba.conf
auth_file = $CONF_DIR/userlist.txt
auth_user = pgbouncer_auth
auth_query = SELECT * FROM pgbouncer.user_lookup(\$1)
admin_users = $ADMIN_USERS
stats_users = pgbouncer_stats
log_connections = 0
log_disconnections = 0
log_pooler_errors = 1
EOF

say "imagem ${APP_COMMIT_SHA:-dev}; $DATABASE e $PROBE em $HOST:$PORT; max_client_conn=$MAX_CLIENT_CONN, default_pool_size=$DEFAULT_POOL_SIZE, max_db_connections=$MAX_DB_CONNECTIONS; console: admin $ADMIN_STATE (só 127.0.0.1), stats $STATS_STATE"

unset PGBOUNCER_AUTH_PASSWORD PGBOUNCER_ADMIN_PASSWORD PGBOUNCER_STATS_PASSWORD
unset ADMIN_PASSWORD STATS_PASSWORD value escaped
exec pgbouncer "$@" "$CONF_DIR/pgbouncer.ini"
