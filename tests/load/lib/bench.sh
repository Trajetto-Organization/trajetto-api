# shellcheck shell=bash
#
# What the CPU bench (plano-escala LOAD-10) shares between cpu-abba.sh and
# cpu-profile.sh: where it may run, how it talks to the harness of
# tests/load/compose.load.yaml, and how it reads a container's CPU.
#
# Sourced, never run. The caller sets BENCH_NAME (the log prefix) and HERE
# (tests/load) before sourcing it.
#
# The bench measures the harness on THIS machine. It never runs on a
# server: it refuses a docker that points at another machine (DOCKER_HOST
# or the current context over ssh:// or tcp://), a node with Dokploy's
# folder, and a node in a Swarm with services, which is what a Dokploy
# server looks like (staging's and production's included).
#
# Environment:
#   LOAD_ENV_FILE         the env file the harness was started with (the
#                         repository's .env); it carries the JWT pair the
#                         replicas need when they are recreated
#   LOAD_EXTRA_ENV_FILES  more env files of that `up`, in order, e.g.
#                         tests/load/vps-6vcpu.env: without it a recreated
#                         replica loses the cpuset the harness had
#   LOAD_PROJECT          the compose project (trajetto-load, the file's name)
#   LOAD_PG_USER          the harness' Postgres user (trajetto)
#   LOAD_CONTEXT_FILE     the seed's tokens, checked before anything runs
#                         (fixtures/load-context.json, the file k6 reads in
#                         the container; another path only for the tests)

BENCH_ROOT="$(cd "$HERE/../.." && pwd)"
BENCH_CONTEXT_FILE="${LOAD_CONTEXT_FILE:-$HERE/fixtures/load-context.json}"
BENCH_COMPOSE_FILE="$HERE/compose.load.yaml"
BENCH_PROJECT="${LOAD_PROJECT:-trajetto-load}"
BENCH_ENV_FILE="${LOAD_ENV_FILE:-$BENCH_ROOT/.env}"
BENCH_PG_USER="${LOAD_PG_USER:-trajetto}"
BENCH_DOKPLOY_DIR="${BENCH_DOKPLOY_DIR:-/etc/dokploy}"

bench_refuse() {
  echo "[$BENCH_NAME] $*" >&2
  exit 2
}

bench_say() { echo "[$BENCH_NAME] $*"; }

# A path as a Windows docker or node reads it: Git Bash hands /c/... over
# as is under MSYS_NO_PATHCONV; cygpath exists only there.
bench_native() { cygpath -m "$1" 2> /dev/null || printf '%s' "$1"; }

bench_is_count() { printf '%s' "$1" | grep -Eq '^[0-9]+$'; }

# Refuses anything but a docker on this machine, and a server's node.
bench_guard_local() {
  local endpoint="${DOCKER_HOST:-}"

  if [ -z "$endpoint" ]; then
    endpoint="$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2> /dev/null || true)"
  fi

  case "$endpoint" in
    "" | unix://* | npipe://*) ;;
    *) bench_refuse "o docker aponta para '$endpoint', outra máquina. A bancada mede o harness desta máquina e nunca roda num servidor (staging, produção, a VPS)." ;;
  esac

  if [ -e "$BENCH_DOKPLOY_DIR" ]; then
    bench_refuse "$BENCH_DOKPLOY_DIR existe: este é um servidor do Dokploy. A bancada roda numa máquina de bancada, nunca na VPS."
  fi

  local state services
  state="$(docker info --format '{{.Swarm.LocalNodeState}}' 2> /dev/null || true)"

  if [ "$state" = "active" ]; then
    services="$(docker service ls -q 2> /dev/null || true)"

    if [ -n "$services" ]; then
      bench_refuse "Este nó está num Swarm com serviços, como um servidor do Dokploy (staging ou produção). A bancada roda numa máquina de bancada, fora de qualquer Swarm."
    fi
  fi
}

# The compose command of the harness, with the env files of its `up`.
bench_compose_init() {
  [ -f "$BENCH_ENV_FILE" ] || bench_refuse "Arquivo de env não encontrado: $BENCH_ENV_FILE. Use o mesmo do 'up' do harness (LOAD_ENV_FILE=<arquivo>); ele traz o JWT_SECRET e o JWT_SECRET_REFRESH_TOKEN."

  BENCH_COMPOSE=(docker compose --env-file "$(bench_native "$BENCH_ENV_FILE")")

  local extra
  for extra in ${LOAD_EXTRA_ENV_FILES:-}; do
    [ -f "$extra" ] || bench_refuse "Arquivo de env não encontrado: $extra (LOAD_EXTRA_ENV_FILES)."
    BENCH_COMPOSE+=(--env-file "$(bench_native "$extra")")
  done

  BENCH_COMPOSE+=(-p "$BENCH_PROJECT" -f "$(bench_native "$BENCH_COMPOSE_FILE")")
}

bench_compose() { "${BENCH_COMPOSE[@]}" "$@"; }

# The running containers of one service of the harness, by compose's labels:
# a service of a profile that is not active is simply empty.
bench_containers() {
  docker ps -q \
    --filter "label=com.docker.compose.project=$BENCH_PROJECT" \
    --filter "label=com.docker.compose.service=$1" | sort
}

# "usage user system" in microseconds, from the container's own cgroup
# (cgroup v2; v1 gives the usage alone). Read inside the container, where a
# private cgroup namespace shows its own cgroup at the root and a host one
# shows the full path (/proc/self/cgroup says which). busybox cat is cheap:
# the read costs the window a millisecond, not a Node start.
bench_cpu_of() {
  # shellcheck disable=SC2016
  docker exec "$1" sh -c '
    p=$(sed -n "s/^0:://p" /proc/self/cgroup 2>/dev/null)
    f="/sys/fs/cgroup${p%/}/cpu.stat"
    [ -r "$f" ] || f=/sys/fs/cgroup/cpu.stat
    if [ -r "$f" ]; then
      cat "$f"
    else
      v=$(cat /sys/fs/cgroup/cpuacct/cpuacct.usage 2>/dev/null || cat "/sys/fs/cgroup/cpu,cpuacct/cpuacct.usage")
      echo "usage_usec $((v / 1000))"
    fi' 2> /dev/null |
    awk '$1 == "usage_usec" { u = $2 } $1 == "user_usec" { s = $2 } $1 == "system_usec" { y = $2 }
      END { if (u == "") exit 1; print u, (s == "" ? 0 : s), (y == "" ? 0 : y) }'
}

# The CPU of the containers given (ids, separated by spaces or lines),
# summed: "usage user system"; "0 0 0" for none.
bench_cpu_sum() {
  local usage=0 user=0 system=0 c u s y

  for c in $1; do
    read -r u s y < <(bench_cpu_of "$c" || echo "x x x")
    bench_is_count "$u" || {
      echo "[$BENCH_NAME] não li a CPU do contêiner $c: o cgroup não respondeu." >&2
      return 1
    }
    usage=$((usage + u))
    user=$((user + s))
    system=$((system + y))
  done

  echo "$usage $user $system"
}

# Waits until every api replica answers its own readiness.
bench_wait_ready() {
  local deadline=$(($(date +%s) + $1)) c pending replicas

  while :; do
    pending=""
    replicas="$(bench_containers api)"

    for c in $replicas; do
      docker exec "$c" wget -q -O /dev/null http://127.0.0.1:3333/health/readiness > /dev/null 2>&1 || pending="$pending $c"
    done

    [ -z "$pending" ] && [ -n "$replicas" ] && return 0

    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "[$BENCH_NAME] as réplicas não ficaram prontas em $1 s:${pending:- nenhuma de pé}" >&2
      return 1
    fi

    sleep 2
  done
}

# k6's load.js inside the harness network at a fixed rate:
#   bench_k6 <id> <rate> <seconds> <work dir>
# The summary goes to <work>/<id>.json, the output to <work>/<id>.log.
# Returns k6's exit: 0, or 99 when a threshold of load.js was crossed.
bench_k6() {
  bench_compose --profile k6 run --rm --no-deps \
    -v "$(bench_native "$4"):/results" \
    -e "LOAD_RATE=$2" -e "LOAD_DURATION=${3}s" \
    k6 run --quiet --summary-export "/results/$1.json" /load/load.js \
    > "$4/$1.log" 2>&1 < /dev/null
}

# The requests of a k6 summary (http_reqs.count), 0 without one.
bench_requests_of() {
  node -e '
    const fs = require("node:fs");
    try {
      const summary = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(String(summary?.metrics?.http_reqs?.count ?? 0));
    } catch {
      process.stdout.write("0");
    }' "$(bench_native "$1")"
}

# The harness commit, with a mark when the tree has local changes.
bench_commit() {
  local commit root
  root="$(bench_native "$BENCH_ROOT")"
  commit="$(git -C "$root" rev-parse --short=12 HEAD 2> /dev/null || echo desconhecido)"

  if [ -n "$(git -C "$root" status --porcelain 2> /dev/null | head -1)" ]; then
    commit="$commit (com mudanças locais)"
  fi

  echo "$commit"
}
