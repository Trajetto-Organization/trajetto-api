#!/usr/bin/env bash
#
# The E2E infra phase (plano-escala F4-38): the files of tests/E2E/infra
# against a REAL PgBouncer and a REAL streaming standby, on a throwaway
# stack of their own, created here and removed at the end:
#
#   <prefix>primary    postgres:16-alpine (the digest of the CI's services)
#                      with the database `trajetto` as a release leaves it
#                      (prisma migrate deploy, then yarn release:steps: the
#                      roles of infra/sql and pgbouncer.user_lookup), the
#                      logins the owner gives by hand (docs/deploy.md:
#                      pgbouncer_auth and trajetto_http, with a password),
#                      and a replication line in pg_hba.conf for the stack's
#                      own network only
#   <prefix>standby    the same image: a pg_basebackup -R of the primary,
#                      streaming as trajetto_replication through a physical
#                      slot (hot standby, read only)
#   <prefix>pgbouncer  the trajetto-pgbouncer image (infra/pgbouncer) in
#                      front of the primary, with the Environment of the
#                      Application and throwaway passwords
#   <prefix>net        their network
#
# A cluster of its own, never the shared test one: the phase gives roles a
# login and a password and holds a replication slot, and those belong to the
# whole cluster. Every port is published on 127.0.0.1 only, on a port Docker
# picks. The passwords are random, made here and never printed; the files
# get the four E2E_INFRA_*_URL (tests/E2E/infra/support/infra-urls.ts),
# and without them they fail instead of skipping.
#
# Usage (from trajetto-api; `yarn test:e2e:infra` is the same):
#   bash tests/E2E/infra/run.sh [vitest arguments]   (the CI: --run --reporter=basic)
#
#   E2E_INFRA_PREFIX           the names' prefix (trajetto-e2e-infra-)
#   E2E_INFRA_PGBOUNCER_IMAGE  a trajetto-pgbouncer image already built (the
#                              CI builds it with its cache); without it, it
#                              is built here from infra/pgbouncer and
#                              removed at the end
#   E2E_INFRA_POSTGRES_IMAGE   the Postgres image (the CI services' digest)
#   E2E_INFRA_KEEP=1           keeps the stack for a look (names printed)
#
# The containers and the network carry the label trajetto.purpose=e2e-infra.
# A name of the stack held by anything without that label stops the run
# (exit 2) and is left alone: never another suite's container, never the
# user's trajetto-database or trajetto-redis.
set -uo pipefail

# Git Bash on Windows rewrites arguments that look like POSIX paths; the
# docker calls below pass paths that belong inside the containers.
export MSYS_NO_PATHCONV=1

cd "$(dirname "$0")/../../.." || exit 2

PREFIX=${E2E_INFRA_PREFIX:-trajetto-e2e-infra-}
POSTGRES_IMAGE=${E2E_INFRA_POSTGRES_IMAGE:-postgres:16-alpine@sha256:0cefaabd882e42bcb2a2f3dc56d3ce4770560ba62fd7f197f1a2e008fd5731ab}
PGBOUNCER_IMAGE=${E2E_INFRA_PGBOUNCER_IMAGE:-}
PURPOSE=e2e-infra
LABEL=trajetto.purpose=$PURPOSE
DATABASE=trajetto
SLOT=e2e_infra_standby

PRIMARY=${PREFIX}primary
STANDBY=${PREFIX}standby
BOUNCER=${PREFIX}pgbouncer
NETWORK=${PREFIX}net
CONTAINERS=("$BOUNCER" "$STANDBY" "$PRIMARY")

BUILT_IMAGE=
STACK_STARTED=
LOG=$(mktemp)

say() { printf 'e2e-infra: %s\n' "$*" >&2; }

# The reason, then the last lines of each container of the stack, so a
# failed start in the CI shows why without a second run.
die() {
  printf 'e2e-infra: ERRO: %s\n' "$*" >&2
  if [ -n "$STACK_STARTED" ]; then
    for name in "${CONTAINERS[@]}"; do
      docker container inspect "$name" > /dev/null 2>&1 || continue
      printf -- '--- %s (últimas linhas) ---\n' "$name" >&2
      docker logs --tail 30 "$name" 2>&1 | sed 's/^/  /' >&2
    done
  fi
  exit 2
}

[[ $PREFIX =~ ^[a-z0-9][a-z0-9-]*-$ ]] ||
  die "E2E_INFRA_PREFIX=$PREFIX inválido: letras minúsculas, dígitos e -, terminando em -"

# The label of a container or network of the stack; fails when the name is
# free. A name without the label reads "<no value>".
label_of() {
  case $1 in
    container) docker container inspect -f '{{index .Config.Labels "trajetto.purpose"}}' "$2" 2> /dev/null ;;
    network) docker network inspect -f '{{index .Labels "trajetto.purpose"}}' "$2" 2> /dev/null ;;
  esac
}

# Removes what the stack left (a run killed halfway included), and only
# that: a name held by something else stops here.
remove_stack() {
  local name label
  for name in "${CONTAINERS[@]}"; do
    label=$(label_of container "$name") || continue
    [ "$label" = "$PURPOSE" ] ||
      die "$name existe e não é da fase infra (sem o label $LABEL): nada foi removido"
    docker rm -f -v "$name" > /dev/null 2>&1 || say "não consegui remover $name"
  done
  if label=$(label_of network "$NETWORK"); then
    [ "$label" = "$PURPOSE" ] ||
      die "a rede $NETWORK existe e não é da fase infra: nada foi removido"
    docker network rm "$NETWORK" > /dev/null 2>&1 || say "não consegui remover a rede $NETWORK"
  fi
}

cleanup() {
  local status=$?
  if [ "${E2E_INFRA_KEEP:-}" = 1 ]; then
    say "E2E_INFRA_KEEP=1: a pilha fica (${CONTAINERS[*]} e a rede $NETWORK)"
  else
    remove_stack
    [ -z "$BUILT_IMAGE" ] || docker image rm "$BUILT_IMAGE" > /dev/null 2>&1 || true
  fi
  rm -f "$LOG"
  exit "$status"
}

# wait_for SECONDS WHAT COMMAND...: COMMAND every second until it succeeds.
wait_for() {
  local seconds=$1 what=$2
  shift 2
  for _ in $(seq 1 "$seconds"); do
    "$@" > /dev/null 2>&1 && return 0
    sleep 1
  done
  die "$what não ficou pronto em ${seconds} s"
}

# The port Docker published for a container's port, on 127.0.0.1; fails
# when there is none (the caller dies: this runs in a subshell).
port_of() {
  local mapping
  mapping=$(docker port "$1" "$2/tcp" 2> /dev/null | head -n 1)
  [ -n "$mapping" ] || return 1
  printf '%s' "${mapping##*:}"
}

# psql inside a container of the stack, as the superuser, over its socket.
psql_in() {
  local container=$1
  shift
  docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$DATABASE" "$@"
}

ready() { docker exec "$1" pg_isready -q -h 127.0.0.1 -U postgres -d "$DATABASE"; }
healthy() { [ "$(docker inspect -f '{{.State.Health.Status}}' "$1" 2> /dev/null)" = healthy ]; }
in_recovery() { [ "$(psql_in "$STANDBY" -tAc 'SELECT pg_is_in_recovery()')" = t ]; }
streaming() {
  [ "$(psql_in "$PRIMARY" -tAc "SELECT count(*) FROM pg_stat_replication WHERE usename = 'trajetto_replication' AND state = 'streaming'")" = 1 ]
}

remove_stack
trap cleanup EXIT
trap 'exit 130' INT TERM
started=$SECONDS

read -r SUPERUSER_PASSWORD AUTH_PASSWORD HTTP_PASSWORD REPLICATION_PASSWORD \
  STATS_PASSWORD ADMIN_PASSWORD < <(node -e "console.log(Array.from({ length: 6 }, () => require('crypto').randomBytes(32).toString('hex')).join(' '))")
[ -n "${ADMIN_PASSWORD:-}" ] || die "as senhas descartáveis não foram geradas"

if [ -z "$PGBOUNCER_IMAGE" ]; then
  BUILT_IMAGE=${PREFIX}pgbouncer-image:local
  say "construindo a imagem do PgBouncer (infra/pgbouncer)"
  if ! docker build -q -t "$BUILT_IMAGE" infra/pgbouncer > "$LOG" 2>&1; then
    tail -n 40 "$LOG" >&2
    die "a imagem do PgBouncer não foi construída"
  fi
  PGBOUNCER_IMAGE=$BUILT_IMAGE
fi

STACK_STARTED=1
docker network create --label "$LABEL" "$NETWORK" > /dev/null ||
  die "a rede $NETWORK não foi criada"

# --- the primary, as a release leaves it ---------------------------------------
docker run -d --name "$PRIMARY" --label "$LABEL" --network "$NETWORK" \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD="$SUPERUSER_PASSWORD" \
  -e POSTGRES_DB="$DATABASE" -p 127.0.0.1::5432 "$POSTGRES_IMAGE" > /dev/null ||
  die "o primário não subiu"
# Over TCP: the image's first-start server listens on the socket only.
wait_for 90 "o primário" ready "$PRIMARY"
PRIMARY_PORT=$(port_of "$PRIMARY" 5432) || die "$PRIMARY não publicou a porta 5432"
PRIMARY_URL="postgresql://postgres:${SUPERUSER_PASSWORD}@127.0.0.1:${PRIMARY_PORT}/${DATABASE}"

# The release step's two commands, as the trajetto-api-migrate runs them.
for command in "prisma migrate deploy" "release:steps"; do
  # shellcheck disable=SC2086 # the command is two words on purpose
  if ! DATABASE_URL="$PRIMARY_URL" yarn --silent $command > "$LOG" 2>&1; then
    tail -n 40 "$LOG" >&2
    die "yarn $command falhou no primário"
  fi
done

# The owner's hand steps (docs/deploy.md): a login and a password for the
# auth login and the runtime; a replication login for the standby (the role
# of infra/sql when it exists, else created here).
psql_in "$PRIMARY" > /dev/null << SQL || die "os logins não foram dados no primário"
ALTER ROLE pgbouncer_auth LOGIN PASSWORD '${AUTH_PASSWORD}';
ALTER ROLE trajetto_http LOGIN PASSWORD '${HTTP_PASSWORD}';
SELECT 'CREATE ROLE trajetto_replication NOLOGIN'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'trajetto_replication')
\gexec
ALTER ROLE trajetto_replication LOGIN REPLICATION PASSWORD '${REPLICATION_PASSWORD}';
SQL

# Replication only for the stack's network, never 'all'.
SUBNET=$(docker network inspect -f '{{range .IPAM.Config}}{{println .Subnet}}{{end}}' "$NETWORK" | grep -m 1 '\.')
[ -n "$SUBNET" ] || die "a rede $NETWORK não tem sub-rede IPv4"
docker exec "$PRIMARY" sh -c \
  'printf "host replication trajetto_replication %s scram-sha-256\n" "$1" >> "$PGDATA/pg_hba.conf"' \
  sh "$SUBNET" || die "a linha de replicação não foi escrita"
psql_in "$PRIMARY" -tAc 'SELECT pg_reload_conf()' > /dev/null || die "o primário não releu o pg_hba.conf"
rules=$(psql_in "$PRIMARY" -tAc "SELECT count(*) FROM pg_hba_file_rules WHERE error IS NULL AND 'replication' = ANY (database) AND 'trajetto_replication' = ANY (user_name)")
[ "$rules" = 1 ] || die "a linha de replicação não entrou no pg_hba.conf do primário"

# --- the standby -----------------------------------------------------------------
docker run -d --name "$STANDBY" --label "$LABEL" --network "$NETWORK" \
  -e PGPASSWORD="$REPLICATION_PASSWORD" -e PRIMARY_HOST="$PRIMARY" -e SLOT="$SLOT" \
  -p 127.0.0.1::5432 --entrypoint sh "$POSTGRES_IMAGE" -ec '
    if [ ! -s "$PGDATA/PG_VERSION" ]; then
      mkdir -p "$PGDATA"
      chown postgres:postgres "$PGDATA"
      chmod 700 "$PGDATA"
      su-exec postgres pg_basebackup -h "$PRIMARY_HOST" -U trajetto_replication \
        -D "$PGDATA" -R -X stream -C -S "$SLOT" -c fast
    fi
    exec docker-entrypoint.sh postgres' > /dev/null || die "o standby não subiu"
wait_for 90 "o standby" ready "$STANDBY"
wait_for 30 "o standby em recuperação" in_recovery
wait_for 30 "o streaming do primário para o standby" streaming
STANDBY_PORT=$(port_of "$STANDBY" 5432) || die "$STANDBY não publicou a porta 5432"

# --- the PgBouncer -------------------------------------------------------------------
docker run -d --name "$BOUNCER" --label "$LABEL" --network "$NETWORK" \
  -e PGBOUNCER_PRIMARY_HOST="$PRIMARY" -e PGBOUNCER_DATABASE="$DATABASE" \
  -e PGBOUNCER_AUTH_PASSWORD="$AUTH_PASSWORD" \
  -e PGBOUNCER_STATS_PASSWORD="$STATS_PASSWORD" \
  -e PGBOUNCER_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  --health-interval 1s --health-start-period 30s \
  -p 127.0.0.1::6432 "$PGBOUNCER_IMAGE" > /dev/null || die "o PgBouncer não subiu"
wait_for 60 "o PgBouncer" healthy "$BOUNCER"
BOUNCER_PORT=$(port_of "$BOUNCER" 6432) || die "$BOUNCER não publicou a porta 6432"

export E2E_INFRA_PRIMARY_URL=$PRIMARY_URL
export E2E_INFRA_STANDBY_URL="postgresql://postgres:${SUPERUSER_PASSWORD}@127.0.0.1:${STANDBY_PORT}/${DATABASE}"
export E2E_INFRA_PGBOUNCER_URL="postgresql://trajetto_http:${HTTP_PASSWORD}@127.0.0.1:${BOUNCER_PORT}/${DATABASE}"
export E2E_INFRA_PGBOUNCER_STATS_URL="postgresql://pgbouncer_stats:${STATS_PASSWORD}@127.0.0.1:${BOUNCER_PORT}/pgbouncer"
unset SUPERUSER_PASSWORD AUTH_PASSWORD HTTP_PASSWORD REPLICATION_PASSWORD \
  STATS_PASSWORD ADMIN_PASSWORD PRIMARY_URL

say "pilha pronta em $((SECONDS - started)) s: primário, standby em streaming e PgBouncer"

E2E_PHASE=infra node ./node_modules/vitest/vitest.mjs run --dir ./tests/E2E "$@"
