#!/usr/bin/env bash
#
# The E2E infra phase (plano-escala F4-38): the files of tests/E2E/infra
# against a REAL PgBouncer and a REAL streaming standby, on a throwaway
# stack of their own, created here and removed at the end:
#
#   <prefix>primary    the trajetto-postgres image without pgBackRest
#                      (infra/postgres, --target wrapper: the official
#                      postgres:16-alpine of the CI's services started
#                      through trajetto-entrypoint.sh, as the Database is),
#                      with the database `trajetto` as a release leaves it
#                      (prisma migrate deploy, then yarn release:steps: the
#                      roles of infra/sql, trajetto_replication included,
#                      and pgbouncer.user_lookup), the logins the owner
#                      gives by hand (docs/deploy.md: pgbouncer_auth,
#                      trajetto_http and trajetto_replication, with a
#                      password), and POSTGRES_REPLICATION_CIDR set to the
#                      two standbys' addresses alone (/30): the image's one
#                      replication line
#   <prefix>standby    the same image, cloned by its standby branch
#                      (POSTGRES_STANDBY_PRIMARY_HOST): a pg_basebackup of
#                      the primary through a physical slot, then streaming
#                      as trajetto_replication from its fixed address (hot
#                      standby, read only)
#   <prefix>promote    a second standby of the same kind, without a slot,
#                      for the failover file to promote (F4-44): the
#                      standby above keeps streaming for the others
#   <prefix>pgbouncer  the trajetto-pgbouncer image (infra/pgbouncer) in
#                      front of the primary, with the Environment of the
#                      Application and throwaway passwords
#   <prefix>net        their network, with a subnet of its own so the
#                      standbys can have fixed addresses; this machine
#                      reaches the published ports from the network's
#                      gateway, outside that /30
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
#   E2E_INFRA_POSTGRES_IMAGE   a trajetto-postgres image already built (the
#                              whole image or its wrapper stage); without
#                              it, --target wrapper of infra/postgres is
#                              built here and removed at the end
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
POSTGRES_IMAGE=${E2E_INFRA_POSTGRES_IMAGE:-}
PGBOUNCER_IMAGE=${E2E_INFRA_PGBOUNCER_IMAGE:-}
PURPOSE=e2e-infra
LABEL=trajetto.purpose=$PURPOSE
DATABASE=trajetto
SLOT=e2e_infra_standby

PRIMARY=${PREFIX}primary
STANDBY=${PREFIX}standby
PROMOTE=${PREFIX}promote
BOUNCER=${PREFIX}pgbouncer
NETWORK=${PREFIX}net
CONTAINERS=("$BOUNCER" "$PROMOTE" "$STANDBY" "$PRIMARY")

BUILT_IMAGES=()
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
    for image in ${BUILT_IMAGES[@]+"${BUILT_IMAGES[@]}"}; do
      docker image rm "$image" > /dev/null 2>&1 || true
    done
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
in_recovery() { [ "$(psql_in "${1:-$STANDBY}" -tAc 'SELECT pg_is_in_recovery()')" = t ]; }
# streaming [N]: N standbys (1 by default) streaming as trajetto_replication.
streaming() {
  [ "$(psql_in "$PRIMARY" -tAc "SELECT count(*) FROM pg_stat_replication WHERE usename = 'trajetto_replication' AND state = 'streaming'")" = "${1:-1}" ]
}

remove_stack
trap cleanup EXIT
trap 'exit 130' INT TERM
started=$SECONDS

read -r SUPERUSER_PASSWORD AUTH_PASSWORD HTTP_PASSWORD REPLICATION_PASSWORD \
  STATS_PASSWORD ADMIN_PASSWORD < <(node -e "console.log(Array.from({ length: 6 }, () => require('crypto').randomBytes(32).toString('hex')).join(' '))")
[ -n "${ADMIN_PASSWORD:-}" ] || die "as senhas descartáveis não foram geradas"

# build TAG WHAT [docker build arguments]: an image of the stack, loaded
# into Docker (--load: the CI's builder is a container) and removed at the
# end.
build() {
  local tag=$1 what=$2
  shift 2
  say "construindo a imagem $what"
  if ! docker build --load -q -t "$tag" "$@" > "$LOG" 2>&1; then
    tail -n 40 "$LOG" >&2
    die "a imagem $what não foi construída"
  fi
  BUILT_IMAGES+=("$tag")
}

if [ -z "$PGBOUNCER_IMAGE" ]; then
  PGBOUNCER_IMAGE=${PREFIX}pgbouncer-image:local
  build "$PGBOUNCER_IMAGE" "do PgBouncer (infra/pgbouncer)" infra/pgbouncer
fi
if [ -z "$POSTGRES_IMAGE" ]; then
  POSTGRES_IMAGE=${PREFIX}postgres-image:local
  build "$POSTGRES_IMAGE" "do Postgres (infra/postgres, --target wrapper)" --target wrapper infra/postgres
fi

STACK_STARTED=1
# A subnet of the network's own, so the standby can have a fixed address
# and the primary's one replication line can name it alone: Docker picks
# a free subnet, which is then taken explicitly (--ip needs that).
docker network create --label "$LABEL" "$NETWORK" > /dev/null ||
  die "a rede $NETWORK não foi criada"
SUBNET=$(docker network inspect -f '{{range .IPAM.Config}}{{println .Subnet}}{{end}}' "$NETWORK" | grep -m 1 '\.')
docker network rm "$NETWORK" > /dev/null || die "a rede $NETWORK não foi recriada"
[[ $SUBNET =~ ^([0-9]+\.[0-9]+\.[0-9]+)\.0/([0-9]+)$ ]] && [ "${BASH_REMATCH[2]}" -le 24 ] ||
  die "a rede $NETWORK veio com a sub-rede '$SUBNET', sem espaço para o endereço fixo do standby"
# .200 and .201: one /30, the network's gateway (.1) outside it.
STANDBY_IP=${BASH_REMATCH[1]}.200
PROMOTE_IP=${BASH_REMATCH[1]}.201
docker network create --label "$LABEL" --subnet "$SUBNET" "$NETWORK" > /dev/null ||
  die "a rede $NETWORK não foi criada com a sub-rede $SUBNET"

# --- the primary, as a release leaves it ---------------------------------------
docker run -d --name "$PRIMARY" --label "$LABEL" --network "$NETWORK" \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD="$SUPERUSER_PASSWORD" \
  -e POSTGRES_DB="$DATABASE" -e POSTGRES_REPLICATION_CIDR="${STANDBY_IP}/30" \
  -p 127.0.0.1::5432 "$POSTGRES_IMAGE" > /dev/null ||
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
# auth login, the runtime and the standby's role (infra/sql gives
# trajetto_replication its REPLICATION, never a login).
psql_in "$PRIMARY" > /dev/null << SQL || die "os logins não foram dados no primário"
ALTER ROLE pgbouncer_auth LOGIN PASSWORD '${AUTH_PASSWORD}';
ALTER ROLE trajetto_http LOGIN PASSWORD '${HTTP_PASSWORD}';
ALTER ROLE trajetto_replication LOGIN PASSWORD '${REPLICATION_PASSWORD}';
SQL

# The image's one replication line: the standbys' addresses, never 'all'.
rules=$(psql_in "$PRIMARY" -tAc "SELECT count(*) FROM pg_hba_file_rules WHERE error IS NULL AND 'replication' = ANY (database) AND 'trajetto_replication' = ANY (user_name) AND address = '${STANDBY_IP}' AND netmask = '255.255.255.252'")
[ "$rules" = 1 ] || die "o pg_hba do primário não tem a linha de replicação de ${STANDBY_IP}/30"

# --- the standby -----------------------------------------------------------------
# Cloned by the image's standby branch, from its fixed address.
docker run -d --name "$STANDBY" --label "$LABEL" --network "$NETWORK" --ip "$STANDBY_IP" \
  -e POSTGRES_STANDBY_PRIMARY_HOST="$PRIMARY" -e POSTGRES_STANDBY_SLOT="$SLOT" \
  -e POSTGRES_REPLICATION_PASSWORD="$REPLICATION_PASSWORD" \
  -p 127.0.0.1::5432 "$POSTGRES_IMAGE" > /dev/null || die "o standby não subiu"
wait_for 90 "o standby" ready "$STANDBY"
wait_for 30 "o standby em recuperação" in_recovery
wait_for 30 "o streaming do primário para o standby" streaming
STANDBY_PORT=$(port_of "$STANDBY" 5432) || die "$STANDBY não publicou a porta 5432"

# The failover's standby: the same branch of the image, no slot.
docker run -d --name "$PROMOTE" --label "$LABEL" --network "$NETWORK" --ip "$PROMOTE_IP" \
  -e POSTGRES_STANDBY_PRIMARY_HOST="$PRIMARY" \
  -e POSTGRES_REPLICATION_PASSWORD="$REPLICATION_PASSWORD" \
  -p 127.0.0.1::5432 "$POSTGRES_IMAGE" > /dev/null || die "o standby do failover não subiu"
wait_for 90 "o standby do failover" ready "$PROMOTE"
wait_for 30 "o standby do failover em recuperação" in_recovery "$PROMOTE"
wait_for 30 "o streaming do primário para os dois standbys" streaming 2
PROMOTE_PORT=$(port_of "$PROMOTE" 5432) || die "$PROMOTE não publicou a porta 5432"

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
export E2E_INFRA_PROMOTE_URL="postgresql://postgres:${SUPERUSER_PASSWORD}@127.0.0.1:${PROMOTE_PORT}/${DATABASE}"
export E2E_INFRA_PGBOUNCER_URL="postgresql://trajetto_http:${HTTP_PASSWORD}@127.0.0.1:${BOUNCER_PORT}/${DATABASE}"
export E2E_INFRA_PGBOUNCER_STATS_URL="postgresql://pgbouncer_stats:${STATS_PASSWORD}@127.0.0.1:${BOUNCER_PORT}/pgbouncer"
export E2E_INFRA_REPLICATION_URL="postgresql://trajetto_replication:${REPLICATION_PASSWORD}@127.0.0.1:${PRIMARY_PORT}/${DATABASE}"
unset SUPERUSER_PASSWORD AUTH_PASSWORD HTTP_PASSWORD REPLICATION_PASSWORD \
  STATS_PASSWORD ADMIN_PASSWORD PRIMARY_URL

say "pilha pronta em $((SECONDS - started)) s: primário, dois standbys em streaming e PgBouncer"

E2E_PHASE=infra node ./node_modules/vitest/vitest.mjs run --dir ./tests/E2E "$@"
