#!/usr/bin/env bash
#
# A capacity gate, run from the GENERATOR machine (plano-escala LOAD-08,
# section 6): the scenes of the gate against an empty target, the facts of
# both machines, and the report docs/desempenho/<date>-<gate>.md with each
# criterion passed or not.
#
#   TARGET_HOST_IP=<target ip> GATE_TARGET_URL=http://<target ip> \
#     GATE_TARGET_SSH=root@<target ip> bash tests/load/gate.sh B|100k|1m|5m
#
# The generator is always another machine (D71): a k6 on the target itself
# proves only the contention between the load and the server. So, before
# anything, it refuses:
#   - production's hosts (api.intrajetto.com, www, the apex) and staging's:
#     no gate loads the production in use, and staging is no ruler;
#   - a TARGET_HOST_IP that is this machine's: loopback, any address of
#     its interfaces, or a target URL whose name resolves to one of them;
#   - a target URL that names another IP than TARGET_HOST_IP.
#
# What each gate runs and how each criterion reads the summaries lives in
# tests/load/lib/gate-report.mjs, which also writes the report. Rows no
# scene of the harness measures come out "pendente", with how to measure
# them: the owner fills them before the report is versioned
# (performance-reports.test.ts refuses a pending row, and a report without
# the commit, the digests or the generator).
#
# From the target, over SSH (GATE_TARGET_SSH): hostname, nproc, memory,
# vmstat 5 during the whole run (steal), docker stats in the middle of each
# scene, the images by digest, and pg_stat_statements (reset at the start,
# top 20 by total time at the end; statistics only). From the target's
# /health/liveness: the commit it serves. From this machine: hostname, the
# address it reaches the target from, nproc, and the harness commit.
#
# Environment (optional unless marked):
#   TARGET_HOST_IP        (required) the target's IP
#   GATE_TARGET_URL       (required) the target's origin, e.g. http://<ip>
#   GATE_TARGET_SSH       (required) user@host for the target's facts
#   GATE_REPLICAS         api replicas on the target (3), for req/s per replica
#   GATE_SCENES           only these scenes (ids of gate-report.mjs), e.g. load
#   GATE_SEED_TIER        the LOAD_TIER the target's database was seeded with
#   GATE_TARGET_MACHINE   provider, plan and region, for the report
#   GATE_PATH             how the load reaches the target (rede privada)
#   GATE_VARIABLES        the target's variables that differ from the default
#   GATE_EXPECT_THROTTLE  true when the panel budget is in enforce (noisy-tenant)
#   GATE_FLEET_SOURCE_ADDRESSES, GATE_FLEET_MIN_ORIGINS
#                         the socket fleet's origins (this machine's address, 1)
#   GATE_CONTEXT_FILE     the seed's tokens (tests/load/fixtures/load-context.json)
#   GATE_PG_CONTAINER, GATE_PG_USER, GATE_PG_DB
#                         the target's Postgres container (name filter), user
#                         and database (postgres, postgres, trajetto)
#   GATE_REPORT_DIR       where the report goes (docs/desempenho)
#   GATE_WORK             the work folder (tests/load/results/gate-<…>)
#   GATE_PREFIX           name of the containers it runs (trajetto-gate)
#
# Exits 0 when the gate passed, 1 when a criterion failed, 2 when it refused
# to start, 3 when it passed what it measures and rows are left pending.
set -u

export MSYS_NO_PATHCONV=1

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
LIB="$HERE/lib/gate-report.mjs"

STEP="${1:-}"
TARGET_URL="${GATE_TARGET_URL:-}"
TARGET_IP="${TARGET_HOST_IP:-}"
SSH_TARGET="${GATE_TARGET_SSH:-}"
REPLICAS="${GATE_REPLICAS:-3}"
SCENES_WANTED="${GATE_SCENES:-}"
REPORT_DIR="${GATE_REPORT_DIR:-$ROOT/docs/desempenho}"
CONTEXT_FILE="${GATE_CONTEXT_FILE:-$HERE/fixtures/load-context.json}"
PG_FILTER="${GATE_PG_CONTAINER:-postgres}"
PG_USER="${GATE_PG_USER:-postgres}"
PG_DB="${GATE_PG_DB:-trajetto}"
NAME="${GATE_PREFIX:-trajetto-gate}"

NODE_IMAGE="node:22.21.1-alpine3.23@sha256:0340fa682d72068edf603c305bfbc10e23219fb0e40df58d9ea4d6f33a9798bf"
K6_IMAGE="grafana/k6:2.2.0@sha256:9bd01d6941fca969cb61bb57d2da5ee9b385fe2aa8881df3798c196564d6ace6"

refuse() {
  echo "[gate] $*" >&2
  exit 2
}

# A path as node reads it: Git Bash hands /c/... to a Windows node, which
# reads C:\c\...; cygpath exists only there.
native() { cygpath -m "$1" 2> /dev/null || printf "%s" "$1"; }

is_ip() {
  printf '%s' "$1" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$|^[0-9a-fA-F]*:[0-9a-fA-F:]*$'
}

# ------------------------------------------------------------ the gate
case "$STEP" in
  B | 100k | 1m | 5m) ;;
  *) refuse "uso: gate.sh B|100k|1m|5m (o portão, plano de escala seção 6)." ;;
esac

# ------------------------------------------------------------ the target
[ -n "$TARGET_URL" ] || refuse "Defina GATE_TARGET_URL (a origem do alvo, ex.: http://<ip do alvo>)."

case "$TARGET_URL" in
  http://* | https://*) ;;
  *) refuse "GATE_TARGET_URL precisa ser http ou https: '$TARGET_URL'." ;;
esac

host="$(printf '%s' "$TARGET_URL" | sed -E 's#^[a-zA-Z]+://(\[[^]]*\]|[^/:]+).*#\1#' | tr '[:upper:]' '[:lower:]')"
bare_host="${host#[}"
bare_host="${bare_host%]}"

case "$host" in
  api.intrajetto.com | www.intrajetto.com | intrajetto.com)
    refuse "$host é a produção em uso: nenhum portão carrega a produção (plano de escala, seção 6)."
    ;;
  localhost | localhost.*)
    refuse "$host é esta máquina: o gerador precisa ser outra (plano de escala, D71)."
    ;;
esac

if printf '%s' "$host" | grep -Eq '(^|[.-])staging([.-]|$)'; then
  refuse "$host é a staging: a staging prova a fiação, nunca capacidade (plano de escala, seção 6)."
fi

[ -n "$TARGET_IP" ] || refuse "Defina TARGET_HOST_IP (o IP do alvo): o portão recusa gerar carga da própria máquina."
is_ip "$TARGET_IP" || refuse "TARGET_HOST_IP não é um endereço IP: '$TARGET_IP'."

if is_ip "$bare_host" && [ "$bare_host" != "$TARGET_IP" ]; then
  refuse "GATE_TARGET_URL aponta para $bare_host e TARGET_HOST_IP é $TARGET_IP: os dois precisam ser o alvo."
fi

# Every address of this machine: its interfaces, and the loopback.
local_ips() {
  {
    ip -o addr show 2> /dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "inet" || $i == "inet6") { split($(i + 1), a, "/"); print a[1] } }'
    hostname -I 2> /dev/null | tr ' ' '\n'
    printf '127.0.0.1\n::1\n'
  } | sed '/^$/d' | sort -u
}

LOCAL_IPS="$(local_ips)"

is_local() { printf '%s\n' "$LOCAL_IPS" | grep -Fxq "$1"; }

case "$TARGET_IP" in
  127.* | 0.0.0.0 | ::1 | ::)
    refuse "TARGET_HOST_IP=$TARGET_IP é esta máquina: o gerador precisa ser outra (plano de escala, D71)."
    ;;
esac

if is_local "$TARGET_IP"; then
  refuse "TARGET_HOST_IP=$TARGET_IP é um IP desta máquina: o gerador precisa ser outra máquina (um k6 no próprio alvo prova só a contenção; plano de escala, D71)."
fi

# A name that resolves, here, to an address of this machine is this machine.
if ! is_ip "$bare_host" && command -v getent > /dev/null 2>&1; then
  for address in $(getent ahosts "$bare_host" 2> /dev/null | awk '{ print $1 }' | sort -u); do
    if is_local "$address"; then
      refuse "$host resolve para $address, um IP desta máquina: o gerador precisa ser outra (plano de escala, D71)."
    fi
  done
fi

# ------------------------------------------------------------ what it needs
integer() { case "$2" in '' | *[!0-9]*) refuse "$1 precisa ser um inteiro: '$2'." ;; esac; }

integer GATE_REPLICAS "$REPLICAS"
[ "$REPLICAS" -ge 1 ] || refuse "GATE_REPLICAS precisa ser pelo menos 1."

for value in "$PG_FILTER" "$PG_USER" "$PG_DB" "$NAME"; do
  printf '%s' "$value" | grep -Eq '^[A-Za-z0-9_.-]+$' \
    || refuse "GATE_PG_CONTAINER, GATE_PG_USER, GATE_PG_DB e GATE_PREFIX aceitam letras, números, ponto, hífen e sublinhado: '$value'."
done

[ -n "$SSH_TARGET" ] || refuse "Defina GATE_TARGET_SSH (usuário@alvo): o nproc, o steal, o docker stats, os digests e o top 20 do pg_stat_statements vêm do alvo."

for tool in docker ssh curl node; do
  command -v "$tool" > /dev/null 2>&1 || refuse "$tool não encontrado neste gerador."
done

[ -f "$CONTEXT_FILE" ] || refuse "Sem $CONTEXT_FILE: rode o seed do degrau contra o banco do alvo (tests/load/README.md)."

SCENES="$(node "$(native "$LIB")" scenes "$STEP" "$SCENES_WANTED")" || exit 2

if printf '%s\n' "$SCENES" | awk '$2 == "fleet"' | grep -q .; then
  [ -f "$ROOT/node_modules/socket.io-client/package.json" ] \
    || refuse "A cena de sockets precisa do socket.io-client: rode yarn install neste repositório."
fi

# ------------------------------------------------------------ the folders
DATE="$(date -u +%F)"
WORK="${GATE_WORK:-$HERE/results/gate-$DATE-$STEP-$(date -u +%H%M%S)}"
mkdir -p "$WORK/results" "$REPORT_DIR"

# A gate run again is a new file: an approved report is never edited.
REPORT="$REPORT_DIR/$DATE-$STEP.md"
n=2
while [ -e "$REPORT" ]; do
  REPORT="$REPORT_DIR/$DATE-$STEP-$n.md"
  n=$((n + 1))
done

# ------------------------------------------------------------ teardown
VMSTAT_PID=""
RUNNING=""

cleanup() {
  [ -n "$VMSTAT_PID" ] && kill "$VMSTAT_PID" 2> /dev/null
  [ -n "$RUNNING" ] && docker rm -f "$RUNNING" > /dev/null 2>&1
}

trap cleanup EXIT
trap 'exit 130' INT TERM

remote() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_TARGET" "$@"; }

# ------------------------------------------------------------ the generator
GEN_HOSTNAME="$(hostname 2> /dev/null)"
GEN_IP="$(ip route get "$TARGET_IP" 2> /dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }')"
[ -n "$GEN_IP" ] || GEN_IP="$(hostname -I 2> /dev/null | awk '{ print $1 }')"
GEN_NPROC="$(nproc 2> /dev/null || getconf _NPROCESSORS_ONLN 2> /dev/null)"
HARNESS_COMMIT="$(git -C "$ROOT" rev-parse HEAD 2> /dev/null)"

[ "$GEN_IP" != "$TARGET_IP" ] || refuse "Este gerador chega ao alvo pelo próprio $TARGET_IP: é a mesma máquina."

# ------------------------------------------------------------ the target's facts
echo "[gate] portão $STEP: alvo $host, gerador $GEN_HOSTNAME ($GEN_IP, $GEN_NPROC núcleos)"

remote sh -s > "$WORK/target.txt" 2> /dev/null << 'REMOTE'
echo '### hostname'; hostname
echo '### nproc'; nproc
echo '### memory'; awk '/^MemTotal:/ { print $2 }' /proc/meminfo
echo '### images'
docker service ls --format '{{.Name}} {{.Image}}' 2> /dev/null
docker ps --format '{{.Names}} {{.Image}}' 2> /dev/null | while read -r name image; do
  printf '%s %s %s\n' "$name" "$image" "$(docker image inspect --format '{{join .RepoDigests " "}}' "$image" 2> /dev/null)"
done
REMOTE

grep -q '^### nproc' "$WORK/target.txt" 2> /dev/null \
  || refuse "O alvo não respondeu pelo SSH ($SSH_TARGET)."

psql_remote() {
  printf 'docker exec -i "$(docker ps -q -f name=%s | head -n 1)" psql -U %s -d %s -At -F " | " -c "%s"\n' \
    "$PG_FILTER" "$PG_USER" "$PG_DB" "$1" | remote sh -s
}

# Statistics only: the top 20 at the end is this run's.
psql_remote "SELECT pg_stat_statements_reset()" > /dev/null 2>&1 \
  || echo "[gate] aviso: o pg_stat_statements do alvo não zerou; o top 20 trará o que havia antes."

curl -s --max-time 10 "$TARGET_URL/health/liveness" > "$WORK/liveness.json" 2> /dev/null

remote vmstat 5 > "$WORK/vmstat.log" 2> /dev/null < /dev/null &
VMSTAT_PID=$!

# ------------------------------------------------------------ the scenes
# The tokens reach the containers by name, never on a command line.
ROLLING_CONTEXT_JSON="$(cat "$CONTEXT_FILE")"
FLEET_CONTEXT_JSON="$ROLLING_CONTEXT_JSON"
export ROLLING_CONTEXT_JSON FLEET_CONTEXT_JSON

: > "$WORK/stats.log"

run_scene() {
  local id="$1" kind="$2" file="$3" seconds="$4" redeploy="$5"
  shift 5

  local args=()
  local pair

  for pair in "$@"; do args+=(-e "$pair"); done

  echo "[gate] cena $id ($file, ~$((seconds / 60)) min)"

  if [ "$redeploy" = 1 ]; then
    echo "[gate] AGORA, com a cena rodando: Redeploy da api do alvo no Dokploy (o veredito é 0 respostas 5xx)."
  fi

  RUNNING="$NAME-$id"

  case "$kind" in
    k6)
      docker run --rm --name "$RUNNING" --network host \
        -v "$HERE:/load:ro" -v "$CONTEXT_FILE:/load/fixtures/load-context.json:ro" \
        -v "$WORK/results:/results" \
        -e "LOAD_BASE_URL=$TARGET_URL" -e "ROLLING_BASE_URL=$TARGET_URL" -e ROLLING_CONTEXT_JSON \
        ${args[@]+"${args[@]}"} "$K6_IMAGE" run --quiet --summary-export "/results/$id.json" "/load/$file" \
        > "$WORK/results/$id.log" 2>&1 < /dev/null &
      ;;
    fleet)
      docker run --rm --name "$RUNNING" --network host \
        -v "$HERE:/load:ro" -v "$ROOT/node_modules:/deps/node_modules:ro" \
        -v "$WORK/results:/results" \
        -e SOCKET_IO_CLIENT_ENTRY=/deps/node_modules/socket.io-client/build/esm/index.js \
        -e "FLEET_URL=$TARGET_URL" -e FLEET_CONTEXT_JSON -e "FLEET_SUMMARY=/results/$id.json" \
        -e "FLEET_MIN_ORIGINS=${GATE_FLEET_MIN_ORIGINS:-1}" \
        -e "FLEET_SOURCE_ADDRESSES=${GATE_FLEET_SOURCE_ADDRESSES:-}" \
        ${args[@]+"${args[@]}"} "$NODE_IMAGE" node /load/socket-fleet.mjs \
        > "$WORK/results/$id.log" 2>&1 < /dev/null &
      ;;
  esac

  local pid=$!

  # The target's containers in the middle of the scene: steady by then.
  sleep "$((seconds / 2))"
  {
    echo "=== $id"
    # < /dev/null: ssh would read the list of scenes the loop reads.
    remote "docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}'" 2> /dev/null < /dev/null
  } >> "$WORK/stats.log"

  wait "$pid"
  echo "$?" > "$WORK/results/$id.exit"
  RUNNING=""
}

while read -r id kind file seconds redeploy envs; do
  [ -n "$id" ] || continue
  # shellcheck disable=SC2086 # one KEY=VALUE per word, by construction
  run_scene "$id" "$kind" "$file" "$seconds" "$redeploy" $envs
done << SCENES
$SCENES
SCENES

kill "$VMSTAT_PID" 2> /dev/null
VMSTAT_PID=""

psql_remote "SELECT round(total_exec_time::numeric, 1), calls, round(mean_exec_time::numeric, 2), left(regexp_replace(query, '[[:space:]]+', ' ', 'g'), 160) FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 20" \
  > "$WORK/pgss.txt" 2> /dev/null || : > "$WORK/pgss.txt"

# ------------------------------------------------------------ the report
{
  echo "STEP=$STEP"
  echo "DATE=$DATE"
  echo "GENERATOR_HOSTNAME=$GEN_HOSTNAME"
  echo "GENERATOR_IP=$GEN_IP"
  echo "GENERATOR_NPROC=$GEN_NPROC"
  echo "PATH_KIND=${GATE_PATH:-rede privada}"
  echo "TARGET_MACHINE=${GATE_TARGET_MACHINE:-}"
  echo "SEED_TIER=${GATE_SEED_TIER:-}"
  echo "REPLICAS=$REPLICAS"
  echo "VARIABLES=${GATE_VARIABLES:-}"
  echo "HARNESS_COMMIT=$HARNESS_COMMIT"
  echo "EXPECT_THROTTLE=${GATE_EXPECT_THROTTLE:-false}"
  echo "SCENES=$(printf '%s\n' "$SCENES" | awk '{ print $1 }' | tr '\n' ' ')"
  echo "WORK_LABEL=${WORK#"$ROOT"/}"
} > "$WORK/meta.env"

result="$(node "$(native "$LIB")" render "$(native "$WORK")" "$(native "$REPORT")")" || {
  echo "[gate] o relatório não foi escrito (os dados ficaram em $WORK)." >&2
  exit 1
}

echo "[gate] relatório: $REPORT ($result)"

case "$result" in
  aprovado) exit 0 ;;
  incompleto)
    echo "[gate] o que o gate mede passou; preencha as linhas pendentes antes de versionar." >&2
    exit 3
    ;;
  *) exit 1 ;;
esac
