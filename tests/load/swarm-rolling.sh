#!/usr/bin/env bash
#
# A rolling deploy rehearsed on a THROWAWAY one-node Swarm, with the flags
# Dokploy gives the API (plano-escala LOAD-06). From the repository root:
#
#   docker build --target migrate -t trajetto-api-migrate:rolling .
#   docker build -t trajetto-api:rolling .
#   ROLLING_IMAGE=trajetto-api:rolling \
#     ROLLING_MIGRATE_IMAGE=trajetto-api-migrate:rolling \
#     bash tests/load/swarm-rolling.sh
#
# What it builds, all named "<ROLLING_PREFIX>-…" and removed at the end:
#   - an attachable overlay network, the way dokploy-network is one;
#   - Postgres 16 and Redis 7 as services (tmpfs, nothing persisted), the
#     release step (`migrate`) once and tests/load/seed.ts, small;
#   - the API as a service of ROLLING_REPLICAS (3) with the Swarm Settings of
#     docs/deploy.md §7.7: Stop Grace Period 40 s, Update and Rollback Config
#     start-first, one at a time, 5 s apart, 30 s monitor, rollback on
#     failure, restart on any exit; the healthcheck is the IMAGE's (the
#     Dockerfile's liveness, the same test the guide pastes);
#   - Traefik pointing at http://<prefix>-api:3333, the service's virtual
#     address, which is what Dokploy writes for an Application's domain.
#
# Then it asks two questions, each answered by a number:
#
#   rolling  `service update --force` (a Redeploy) under ROLLING_RATE req/s
#            (tests/load/rolling.js): ZERO 5xx and zero requests without an
#            answer, and every replaced replica logged "shutdown complete"
#            and exited 0 — the shutdown fit the grace (F1-14, F1-15).
#   scale    from ROLLING_REPLICAS to ROLLING_SCALE_TO (6) under the same
#            load: over ROLLING_BALANCE_WINDOW seconds (300) after the new
#            replicas are healthy, the busiest replica served at most
#            ROLLING_BALANCE_MAX (1.3) times the average. Without
#            HTTP_MAX_REQUESTS_PER_SOCKET the keep-alive connections Traefik
#            already holds never move, and the new replicas sit idle.
#
# The replicas get HTTP_MAX_REQUESTS_PER_SOCKET=100 here, not production's
# 1000 (ROLLING_MAX_REQUESTS_PER_SOCKET). At 50 req/s through one Traefik
# with about one request in flight, a socket of 1000 carries twenty seconds
# of the WHOLE load: the 5-minute window holds some fifteen sockets, each
# replica's count comes out in steps of 1000 and the ratio measures how they
# fell (1.48 measured on 15/11/2026 with the cap working). With 100 the
# window holds 150 sockets and the ratio measures the spread. The mechanism
# under test is the same — the cap closes the socket with `Connection:
# close` and the next one lands elsewhere — and a build without the cap
# still leaves the new replicas idle. Production's own number is checked at
# production's rates, by the burn-in of a new server (portão B).
#
# It refuses a node that is already in a Swarm with services: that is what
# a Dokploy server looks like, production's included. On a node outside any
# Swarm it runs `docker swarm init` (loopback only) and leaves the Swarm at
# the end; on a Swarm with no services it uses it and leaves it as it was.
#
# Environment (optional unless marked):
#   ROLLING_IMAGE           the API image (required; built locally)
#   ROLLING_MIGRATE_IMAGE   the release image, Dockerfile target `migrate`
#                           (required)
#   ROLLING_NEXT_IMAGE      the image the update moves to (default: the same
#                           one, with --force: what Redeploy does)
#   ROLLING_PREFIX          name of everything created (default
#                           trajetto-rolling)
#   ROLLING_STEPS           "rolling scale" (default both)
#   ROLLING_REPLICAS / ROLLING_SCALE_TO   3 / 6
#   ROLLING_RATE            requests per second (default 50)
#   ROLLING_STOP_GRACE      the service's Stop Grace Period (default 40s;
#                           10s is Dokploy without the field). The API gets
#                           STOP_GRACE_PERIOD_MS with the same value.
#   ROLLING_LOAD_DURATION   load around the update (default 6m)
#   ROLLING_SCALE_SETTLE    seconds the new replicas get to turn healthy
#                           (default 180)
#   ROLLING_BALANCE_WINDOW / ROLLING_BALANCE_MAX   300 / 1.3
#   ROLLING_MAX_REQUESTS_PER_SOCKET  the replicas' HTTP_MAX_REQUESTS_PER_SOCKET
#                           (default 100; see above)
#   ROLLING_MEMORY         memory limit per replica (default 1024M, as
#                           production)
#   ROLLING_PG_PORT         host port of the throwaway Postgres, for the seed
#                           (default 54391)
#   ROLLING_ADVERTISE_ADDR  for `swarm init` (default 127.0.0.1)
#   ROLLING_KEEP=1          keep everything up afterwards, for a look
#
# Exits 0 when every question passed, 1 when one failed, 2 when it refused
# to start.
set -u

# Git Bash would rewrite /var/lib/... in --mount and every container path.
export MSYS_NO_PATHCONV=1

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

PREFIX="${ROLLING_PREFIX:-trajetto-rolling}"
IMAGE="${ROLLING_IMAGE:-}"
MIGRATE_IMAGE="${ROLLING_MIGRATE_IMAGE:-}"
NEXT_IMAGE="${ROLLING_NEXT_IMAGE:-}"
STEPS=" ${ROLLING_STEPS-rolling scale} "
REPLICAS="${ROLLING_REPLICAS:-3}"
SCALE_TO="${ROLLING_SCALE_TO:-6}"
RATE="${ROLLING_RATE:-50}"
GRACE="${ROLLING_STOP_GRACE:-40s}"
LOAD_DURATION="${ROLLING_LOAD_DURATION:-6m}"
SCALE_SETTLE="${ROLLING_SCALE_SETTLE:-180}"
BALANCE_WINDOW="${ROLLING_BALANCE_WINDOW:-300}"
BALANCE_MAX="${ROLLING_BALANCE_MAX:-1.3}"
SOCKET_REQUESTS="${ROLLING_MAX_REQUESTS_PER_SOCKET:-100}"
MEMORY="${ROLLING_MEMORY:-1024M}"
PG_PORT="${ROLLING_PG_PORT:-54391}"
ADVERTISE="${ROLLING_ADVERTISE_ADDR:-127.0.0.1}"
KEEP="${ROLLING_KEEP:-0}"

# The harness's pins (compose.load.yaml), so both benches run the same edge
# and the same generator.
TRAEFIK_IMAGE="traefik:v3.7.13@sha256:24841fe2de7304c149343d877d2923b4c8800a38ba015dea9174c23b20e344a0"
K6_IMAGE="grafana/k6:2.2.0@sha256:9bd01d6941fca969cb61bb57d2da5ee9b385fe2aa8881df3798c196564d6ace6"
PG_IMAGE="postgres:16-alpine"
REDIS_IMAGE="redis:7-alpine"

NET="$PREFIX-net"
API="$PREFIX-api"
EDGE="$PREFIX-edge"
PG="$PREFIX-pg"
REDIS="$PREFIX-redis"
ROUTES="$PREFIX-edge-routes"

FAILURES=0
CREATED_SWARM=0
STARTED=0
WORK=""

say() { printf '\n== %s ==\n' "$*"; }
refuse() {
  echo "[swarm-rolling] $*" >&2
  exit 2
}
failed() {
  echo "  REPROVADO: $*"
  FAILURES=$((FAILURES + 1))
}
asked() { case "$STEPS" in *" $1 "*) return 0 ;; esac; return 1; }

# A path node (on Windows) can open; the shell's own everywhere else.
native() {
  if command -v cygpath > /dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

integer() { case "$2" in '' | *[!0-9]*) refuse "$1 precisa ser um inteiro: '$2'." ;; esac; }

seconds_of() {
  case "$1" in
    *m) echo $((${1%m} * 60)) ;;
    *s) echo "${1%s}" ;;
    *) refuse "duração sem unidade (use s ou m): '$1'." ;;
  esac
}

# --------------------------------------------------------------- preflight
command -v docker > /dev/null 2>&1 || refuse "docker não encontrado."
command -v node > /dev/null 2>&1 || refuse "node não encontrado (o seed roda nele)."

[ -n "$IMAGE" ] || refuse "Defina ROLLING_IMAGE (a imagem da API, construída com docker build -t <tag> .)."
[ -n "$MIGRATE_IMAGE" ] || refuse "Defina ROLLING_MIGRATE_IMAGE (docker build --target migrate -t <tag> .)."

integer ROLLING_REPLICAS "$REPLICAS"
integer ROLLING_SCALE_TO "$SCALE_TO"
integer ROLLING_RATE "$RATE"
integer ROLLING_SCALE_SETTLE "$SCALE_SETTLE"
integer ROLLING_BALANCE_WINDOW "$BALANCE_WINDOW"
integer ROLLING_PG_PORT "$PG_PORT"
integer ROLLING_MAX_REQUESTS_PER_SOCKET "$SOCKET_REQUESTS"

[ "$SCALE_TO" -gt "$REPLICAS" ] || refuse "ROLLING_SCALE_TO ($SCALE_TO) precisa passar de ROLLING_REPLICAS ($REPLICAS)."

case "$PG_PORT" in
  5432 | 3001 | 3333) refuse "ROLLING_PG_PORT=$PG_PORT é de outro serviço; escolha uma porta livre." ;;
esac

case "$GRACE" in
  *[!0-9]*s | s | '') refuse "ROLLING_STOP_GRACE precisa ser em segundos, como 40s: '$GRACE'." ;;
  *s) GRACE_MS=$((${GRACE%s} * 1000)) ;;
  *) refuse "ROLLING_STOP_GRACE precisa ser em segundos, como 40s: '$GRACE'." ;;
esac

LOAD_SECONDS="$(seconds_of "$LOAD_DURATION")"

for image in "$IMAGE" "$MIGRATE_IMAGE" ${NEXT_IMAGE:+"$NEXT_IMAGE"}; do
  docker image inspect "$image" > /dev/null 2>&1 \
    || refuse "Imagem não encontrada aqui: $image (construa antes; o ensaio não puxa do GHCR)."
done

STATE="$(docker info --format '{{.Swarm.LocalNodeState}}' 2> /dev/null)" \
  || refuse "docker info falhou: o daemon está de pé?"

case "$STATE" in
  active)
    if [ -n "$(docker service ls -q 2> /dev/null)" ]; then
      refuse "Este nó já está num Swarm com serviços. O ensaio só roda num Swarm descartável, nunca num servidor do Dokploy (staging ou produção). Rode numa máquina de bancada, fora de qualquer Swarm."
    fi

    [ "$(docker info --format '{{.Swarm.ControlAvailable}}' 2> /dev/null)" = "true" ] \
      || refuse "Este nó é worker de um Swarm; o ensaio precisa de um manager descartável."
    ;;
  inactive) ;;
  *) refuse "Estado do Swarm inesperado: '$STATE'." ;;
esac

# ---------------------------------------------------------------- teardown
task_containers() {
  docker ps -q --filter "label=com.docker.swarm.service.name=$1" 2> /dev/null
}

cleanup() {
  [ "$STARTED" = "1" ] || return 0

  if [ "$KEEP" = "1" ]; then
    echo "[swarm-rolling] ROLLING_KEEP=1: tudo continua de pé (prefixo $PREFIX). Para desmontar: docker service rm $API $EDGE $PG $REDIS; docker config rm $ROUTES; docker network rm $NET$([ "$CREATED_SWARM" = "1" ] && printf '; docker swarm leave --force; docker network rm docker_gwbridge')."
    return 0
  fi

  docker rm -f "$PREFIX-k6-rolling" "$PREFIX-k6-scale" "$PREFIX-migrate" > /dev/null 2>&1

  for service in "$API" "$EDGE" "$REDIS" "$PG"; do
    docker service rm "$service" > /dev/null 2>&1
  done

  # The network goes only after the last task left it; the API's tasks get
  # their grace on the way out.
  for _ in $(seq 1 120); do
    left=""
    for service in "$API" "$EDGE" "$REDIS" "$PG"; do
      left="$left$(docker ps -aq --filter "label=com.docker.swarm.service.name=$service" 2> /dev/null)"
    done
    [ -z "$left" ] && break
    sleep 1
  done

  docker config rm "$ROUTES" > /dev/null 2>&1
  docker network rm "$NET" > /dev/null 2>&1
  [ -n "$WORK" ] && rm -rf "$WORK"

  if [ "$CREATED_SWARM" = "1" ]; then
    docker swarm leave --force > /dev/null 2>&1 \
      || echo "[swarm-rolling] docker swarm leave falhou; saia à mão: docker swarm leave --force" >&2

    # `swarm init` creates docker_gwbridge and `leave` keeps it.
    [ "$HAD_GWBRIDGE" = "1" ] || docker network rm docker_gwbridge > /dev/null 2>&1
  fi
}

trap cleanup EXIT
trap 'exit 130' INT TERM

STARTED=1

HAD_GWBRIDGE=0
docker network inspect docker_gwbridge > /dev/null 2>&1 && HAD_GWBRIDGE=1

if [ "$STATE" = "inactive" ]; then
  docker swarm init --advertise-addr "$ADVERTISE" --listen-addr "$ADVERTISE:2377" > /dev/null \
    || refuse "docker swarm init falhou (ROLLING_ADVERTISE_ADDR=$ADVERTISE)."
  CREATED_SWARM=1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/$PREFIX.XXXXXX")"

random() { node -e "process.stdout.write(require('crypto').randomBytes($1).toString('$2'))"; }

PG_PASSWORD="$(random 16 hex)"
JWT_SECRET="$(random 48 base64)"
JWT_SECRET_REFRESH_TOKEN="$(random 48 base64)"

# The replicas' environment: the harness's (compose.load.yaml), on this
# network, plus the grace the service is given.
API_ENV=(
  -e NODE_ENV=production
  -e APP_ENV=development
  -e "NODE_OPTIONS=--max-old-space-size=768"
  -e "DATABASE_URL=postgresql://trajetto:$PG_PASSWORD@$PG:5432/rolling?schema=public&connection_limit=10&pool_timeout=20&connect_timeout=5"
  -e "MIGRATION_DATABASE_URL=postgresql://trajetto:$PG_PASSWORD@$PG:5432/rolling?schema=public&connection_limit=2"
  -e "REDIS_URL=redis://$REDIS:6379"
  -e HTTP_REQUEST=http://localhost:3000
  -e "API_HTTP_REQUEST=http://$EDGE"
  -e "JWT_SECRET=$JWT_SECRET"
  -e "JWT_SECRET_REFRESH_TOKEN=$JWT_SECRET_REFRESH_TOKEN"
  -e MASTER_USER_EMAIL=rolling-master@example.com
  -e MASTER_USER_INITIAL_PASSWORD=rolling-rehearsal-only
  -e UPLOAD_STORAGE_TYPE=r2
  -e R2_ACCOUNT_ID=rolling
  -e R2_BUCKET_NAME=rolling
  -e R2_ACCESS_KEY_ID=rolling
  -e R2_SECRET_ACCESS_KEY=rolling
  -e UPLOAD_ORPHAN_GC=off
  -e RATE_LIMIT_TRUSTED_PROXY=xff
  -e WORKERS_ENABLED=true
  -e "STOP_GRACE_PERIOD_MS=$GRACE_MS"
  -e "HTTP_MAX_REQUESTS_PER_SOCKET=$SOCKET_REQUESTS"
)

wait_for() {
  # wait_for <seconds> <what> <command...>
  local limit="$1" what="$2"
  shift 2

  for _ in $(seq 1 "$limit"); do
    "$@" > /dev/null 2>&1 && return 0
    sleep 1
  done

  refuse "$what não ficou pronto em ${limit} s."
}

pg_ready() {
  local container
  container="$(task_containers "$PG" | head -n 1)"
  # Over TCP: the image's init server listens on the socket only, and a
  # socket check passes before the real server is up.
  [ -n "$container" ] && docker exec "$container" pg_isready -h 127.0.0.1 -U trajetto -d rolling
}

redis_ready() {
  local container
  container="$(task_containers "$REDIS" | head -n 1)"
  [ -n "$container" ] && [ "$(docker exec "$container" redis-cli ping 2> /dev/null)" = "PONG" ]
}

# healthy <service> <n>: exactly n tasks running, all healthy.
healthy() {
  local containers count=0 total=0
  containers="$(task_containers "$1")"

  for container in $containers; do
    total=$((total + 1))
    [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container" 2> /dev/null)" = "healthy" ] \
      && count=$((count + 1))
  done

  [ "$total" -eq "$2" ] && [ "$count" -eq "$2" ]
}

edge_routes() {
  local container
  container="$(task_containers "$EDGE" | head -n 1)"
  [ -n "$container" ] && docker exec "$container" wget -q -O /dev/null "http://127.0.0.1/health/liveness"
}

# -------------------------------------------------------------- the stack
say "Swarm descartável ($PREFIX)"

docker network create --driver overlay --attachable "$NET" > /dev/null \
  || refuse "não foi possível criar a rede $NET."

docker service create --detach --no-resolve-image --name "$PG" --network "$NET" \
  --publish "published=$PG_PORT,target=5432" \
  --mount type=tmpfs,target=/var/lib/postgresql/data \
  -e POSTGRES_USER=trajetto -e "POSTGRES_PASSWORD=$PG_PASSWORD" -e POSTGRES_DB=rolling \
  "$PG_IMAGE" -c max_connections=200 > /dev/null || refuse "o Postgres não subiu."

docker service create --detach --no-resolve-image --name "$REDIS" --network "$NET" \
  --mount type=tmpfs,target=/data \
  "$REDIS_IMAGE" redis-server --save "" --appendonly no > /dev/null || refuse "o Redis não subiu."

wait_for 180 "O Postgres" pg_ready
wait_for 60 "O Redis" redis_ready

echo "  migrations e seeds (a etapa de release, uma vez)"
docker run --rm --name "$PREFIX-migrate" --network "$NET" "${API_ENV[@]}" \
  -e ALLOW_EMPTY_DATABASE_BOOTSTRAP=true \
  "$MIGRATE_IMAGE" ./docker-entrypoint.sh migrate > "$WORK/migrate.log" 2>&1 \
  || {
    tail -n 30 "$WORK/migrate.log" >&2
    refuse "a etapa de release falhou."
  }

echo "  dados de carga (tests/load/seed.ts, pequeno)"
(
  cd "$ROOT" \
    && NODE_ENV=development APP_ENV=development \
      DATABASE_URL="postgresql://trajetto:$PG_PASSWORD@localhost:$PG_PORT/rolling?schema=public" \
      LOAD_PG_PORT="$PG_PORT" REDIS_URL=redis://localhost:6379 \
      HTTP_REQUEST=http://localhost:3000 \
      JWT_SECRET="$JWT_SECRET" JWT_SECRET_REFRESH_TOKEN="$JWT_SECRET_REFRESH_TOKEN" \
      MASTER_USER_EMAIL=rolling-master@example.com MASTER_USER_INITIAL_PASSWORD=rolling-rehearsal-only \
      LOAD_TENANTS=3 LOAD_DELIVERIES=40 LOAD_DRIVERS=5 LOAD_PRIMARY_DRIVERS=60 LOAD_MANAGERS=20 \
      LOAD_BASE_URL="http://$EDGE" LOAD_CONTEXT_OUT="$(native "$WORK/context.json")" \
      npx tsx tests/load/seed.ts
) > "$WORK/seed.log" 2>&1 || {
  tail -n 30 "$WORK/seed.log" >&2
  refuse "o seed falhou."
}

[ -s "$WORK/context.json" ] || refuse "o seed não escreveu o contexto."
export ROLLING_CONTEXT_JSON
ROLLING_CONTEXT_JSON="$(cat "$WORK/context.json")"

echo "  a API: $REPLICAS réplicas, Stop Grace Period $GRACE, start-first com rollback"
# The Swarm Settings of docs/deploy.md §7.7 as flags (swarm-rolling-script
# test compares them with the guide's JSON). No --health-*: the image's
# HEALTHCHECK is the test the guide pastes.
docker service create --detach --no-resolve-image --name "$API" --network "$NET" \
  --replicas "$REPLICAS" \
  --stop-grace-period "$GRACE" \
  --update-parallelism 1 --update-delay 5s --update-failure-action rollback \
  --update-monitor 30s --update-order start-first \
  --rollback-parallelism 1 --rollback-delay 5s --rollback-monitor 30s \
  --rollback-order start-first \
  --restart-condition any --restart-delay 5s --restart-max-attempts 0 \
  --limit-memory "$MEMORY" \
  "${API_ENV[@]}" \
  "$IMAGE" > /dev/null || refuse "a API não foi criada."

# Dokploy's file provider names the Application by its App Name: the
# service's virtual address, never a task.
printf '%s\n' \
  "http:" \
  "  routers:" \
  "    api:" \
  "      rule: \"PathPrefix(\`/\`)\"" \
  "      entryPoints: [web]" \
  "      service: api" \
  "  services:" \
  "    api:" \
  "      loadBalancer:" \
  "        passHostHeader: true" \
  "        servers:" \
  "          - url: \"http://$API:3333\"" \
  | docker config create "$ROUTES" - > /dev/null || refuse "a config do Traefik não foi criada."

docker service create --detach --no-resolve-image --name "$EDGE" --network "$NET" \
  --config "source=$ROUTES,target=/etc/traefik/dynamic/routes.yml" \
  "$TRAEFIK_IMAGE" \
  --providers.file.filename=/etc/traefik/dynamic/routes.yml \
  --entrypoints.web.address=:80 \
  --entrypoints.web.transport.respondingtimeouts.readtimeout=120s \
  --accesslog=true --accesslog.format=json \
  --accesslog.fields.headers.defaultmode=drop \
  --ping=true > /dev/null || refuse "o Traefik não subiu."

wait_for 300 "A API ($REPLICAS réplicas saudáveis)" healthy "$API" "$REPLICAS"
wait_for 60 "O Traefik" edge_routes

# ------------------------------------------------------------- the load
# start_load <phase> <duration>: k6 in the background, on the network.
start_load() {
  docker run --rm -i --name "$PREFIX-k6-$1" --network "$NET" \
    -e "ROLLING_BASE_URL=http://$EDGE" -e "ROLLING_RATE=$RATE" \
    -e "ROLLING_DURATION=$2" -e ROLLING_MAX_VUS=100 -e ROLLING_CONTEXT_JSON \
    "$K6_IMAGE" run --quiet - < "$HERE/rolling.js" > "$WORK/k6-$1.log" 2>&1 &
  LOAD_PID=$!
}

finish_load() {
  wait "$LOAD_PID"
  local status=$?

  grep -E 'rolling_(5xx|transport_errors|unexpected|throttled)|http_reqs|✗|✓' "$WORK/k6-$1.log" | sed 's/^/  /'

  if [ "$status" -ne 0 ]; then
    failed "a carga ($1) reprovou: respostas 5xx, sem resposta ou fora do esperado (k6 saiu com $status)."
    tail -n 40 "$WORK/k6-$1.log" | sed 's/^/    /'
  fi
}

update_state() {
  docker service inspect "$API" --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{end}}' 2> /dev/null
}

if asked rolling; then
  say "1. Rolling: Redeploy sob $RATE req/s, 0 respostas 5xx"

  before="$(task_containers "$API" | sort)"
  started_at="$(date +%s)"
  start_load rolling "$LOAD_DURATION"

  # Warm: Traefik holds keep-alive connections to the old replicas before
  # the update, which is the state a real Redeploy finds.
  sleep 30

  if [ -n "$NEXT_IMAGE" ]; then
    docker service update --detach --no-resolve-image --image "$NEXT_IMAGE" "$API" > /dev/null
  else
    docker service update --detach --force "$API" > /dev/null
  fi

  state=""
  deadline=$((started_at + LOAD_SECONDS - 15))

  while [ "$(date +%s)" -lt "$deadline" ]; do
    state="$(update_state)"
    case "$state" in completed | rollback_* | paused) break ;; esac
    sleep 2
  done

  echo "  update: ${state:-sem estado}, em $(($(date +%s) - started_at - 30)) s"

  case "$state" in
    completed) ;;
    rollback_* | paused) failed "o Swarm não completou o update ($state): uma réplica nova não ficou saudável." ;;
    *) failed "o update não terminou dentro da carga (ROLLING_LOAD_DURATION=$LOAD_DURATION); aumente-a." ;;
  esac

  finish_load rolling

  # Each replaced replica: exit 0 and the line the shutdown writes last.
  # A SIGKILL at the end of the grace is 137 and no line.
  for container in $before; do
    code="$(docker inspect --format '{{.State.ExitCode}}' "$container" 2> /dev/null)"
    line="$(docker logs "$container" 2>&1 | grep '"shutdown complete"' | tail -n 1)"
    took="$(printf '%s' "$line" | sed -n 's/.*"durationMs":\([0-9]*\).*/\1/p')"

    echo "  réplica substituída ${container}: saída ${code:-?}, desligamento ${took:-?} ms"

    if [ "$code" != "0" ] || [ -z "$line" ]; then
      failed "a réplica $container não terminou o desligamento dentro do grace de $GRACE (saída ${code:-?})."
    fi
  done
fi

if asked scale; then
  say "2. Escala de $REPLICAS para $SCALE_TO sob $RATE req/s: máximo/média ≤ $BALANCE_MAX"

  start_load scale "$((20 + SCALE_SETTLE + BALANCE_WINDOW + 20))s"
  sleep 20

  docker service update --detach --replicas "$SCALE_TO" "$API" > /dev/null

  for _ in $(seq 1 "$SCALE_SETTLE"); do
    healthy "$API" "$SCALE_TO" && break
    sleep 1
  done

  if ! healthy "$API" "$SCALE_TO"; then
    failed "as $SCALE_TO réplicas não ficaram saudáveis em $SCALE_SETTLE s."
  else
    from="$(date +%s)"
    sleep "$BALANCE_WINDOW"
    until="$(date +%s)"

    counts=""
    for container in $(task_containers "$API"); do
      served="$(docker logs --since "$from" --until "$until" "$container" 2>&1 | grep -c '"request completed"')"
      echo "  réplica ${container}: $served respostas em $((until - from)) s"
      counts="$counts $served"
    done

    verdict="$(printf '%s\n' $counts | awk -v limit="$BALANCE_MAX" '
      { n++; sum += $1; if ($1 > max) max = $1; if (n == 1 || $1 < min) min = $1 }
      END {
        if (n == 0 || sum == 0) { print "sem respostas"; exit 1 }
        ratio = max / (sum / n)
        printf "máximo/média = %.2f (mínimo %d, máximo %d, média %.0f)\n", ratio, min, max, sum / n
        exit (ratio <= limit && min > 0) ? 0 : 1
      }')"
    balanced=$?

    echo "  $verdict"
    [ "$balanced" -eq 0 ] || failed "a carga não se espalhou nas réplicas novas ($verdict; o teto é $BALANCE_MAX)."
  fi

  finish_load scale
fi

if [ "$FAILURES" -gt 0 ]; then
  say "$FAILURES verificação(ões) reprovou(aram)"
  exit 1
fi

say "Aprovado"
exit 0
