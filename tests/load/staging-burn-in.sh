#!/usr/bin/env bash
#
# A short, capped burn-in of STAGING, from the VPS host (plano-escala LOAD-09).
# It proves the wiring and the rolling deploy under load, never capacity:
# staging shares the one VPS with production, so the caps below are what
# keeps production's users from paying for the test.
#
#   FIXTURE_ADMIN_EMAIL=... FIXTURE_ADMIN_PASSWORD=... \
#     bash tests/load/staging-burn-in.sh
#
# (and, while it runs, Redeploy the staging API in Dokploy: the verdict is
# zero 5xx — docs/deploy.md, "Ensaio de carga na staging").
#
# What it does:
#   1. Refuses, before anything: a production host; more than 30 req/s, 10
#      minutes or 200 sockets; outside 06:00–08:00 UTC (03:00–05:00 BRT,
#      the `load-window` of docs/operacao/jobs.md), on the 1st (the restore
#      drill) and on Sundays (the history window).
#   2. Runs tests/load/staging-fixture.mjs in a node container on
#      dokploy-network, against Traefik with staging's Host: it signs in as
#      the administrator of 'Carga (staging)' and prepares drivers, routes
#      and deliveries through the API. The tokens it prints stay in memory.
#   3. Measures production's /health/readiness (a database round trip) six
#      times: the base.
#   4. Runs tests/load/rolling.js in k6 (`--cpus 0.5 --memory 256m`) on
#      dokploy-network against Traefik, and every BURN_IN_PROBE_EVERY
#      seconds aborts everything when:
#        - production's readiness p95 passes 2× the base (and the floor of
#          BURN_IN_PROBE_FLOOR_MS), or fails 3 times;
#        - vmstat on the host shows iowait above 20% or steal above 10%.
#
# Environment (optional unless marked):
#   FIXTURE_ADMIN_EMAIL, FIXTURE_ADMIN_PASSWORD  (required) the administrator
#                       of 'Carga (staging)'; passed to the container by
#                       name, never on a command line
#   FIXTURE_DRIVERS, FIXTURE_STOPS   the fixture's size (12 and 3)
#   BURN_IN_HOST        staging's API host (api-staging.intrajetto.com)
#   BURN_IN_SCHEME      https (Traefik on 443 with the real certificate)
#   BURN_IN_NETWORK     dokploy-network
#   BURN_IN_EDGE        the Traefik container (dokploy-traefik)
#   BURN_IN_RATE        req/s (20; at most 30)
#   BURN_IN_DURATION    k6 duration (10m; at most 10m)
#   BURN_IN_MAX_VUS     virtual users, so sockets (100; at most 200)
#   BURN_IN_PROBE_URL   production's readiness
#                       (https://api.intrajetto.com/health/readiness)
#   BURN_IN_PROBE_RESOLVE  the address curl resolves the probe host to
#                       (127.0.0.1: the host's own Traefik; empty = DNS)
#   BURN_IN_PROBE_EVERY seconds between samples (5)
#   BURN_IN_PROBE_FLOOR_MS  the smallest p95 that aborts (50): twice a
#                       3 ms base is noise, not a production in trouble
#   BURN_IN_PREFIX      name of the two containers it runs (trajetto-burn-in)
#
# Exits 0 when the load passed (zero 5xx), 1 when it failed, 2 when it
# refused to start, 3 when a probe aborted it.
set -u

export MSYS_NO_PATHCONV=1

HERE="$(cd "$(dirname "$0")" && pwd)"

HOST="${BURN_IN_HOST:-api-staging.intrajetto.com}"
SCHEME="${BURN_IN_SCHEME:-https}"
NETWORK="${BURN_IN_NETWORK:-dokploy-network}"
EDGE="${BURN_IN_EDGE:-dokploy-traefik}"
RATE="${BURN_IN_RATE:-20}"
DURATION="${BURN_IN_DURATION:-10m}"
MAX_VUS="${BURN_IN_MAX_VUS:-100}"
PROBE_URL="${BURN_IN_PROBE_URL:-https://api.intrajetto.com/health/readiness}"
PROBE_RESOLVE="${BURN_IN_PROBE_RESOLVE-127.0.0.1}"
PROBE_EVERY="${BURN_IN_PROBE_EVERY:-5}"
PROBE_FLOOR_MS="${BURN_IN_PROBE_FLOOR_MS:-50}"
NAME="${BURN_IN_PREFIX:-trajetto-burn-in}"

# The caps of plano-escala section 6 (2): staging on the single VPS.
MAX_RATE=30
MAX_SECONDS=600
MAX_SOCKETS=200
# The load window, UTC (docs/operacao/jobs.md, `load-window`).
WINDOW_FROM=360
WINDOW_TO=480

NODE_IMAGE="node:22.21.1-alpine3.23@sha256:0340fa682d72068edf603c305bfbc10e23219fb0e40df58d9ea4d6f33a9798bf"
K6_IMAGE="grafana/k6:2.2.0@sha256:9bd01d6941fca969cb61bb57d2da5ee9b385fe2aa8881df3798c196564d6ace6"

refuse() {
  echo "[burn-in] $*" >&2
  exit 2
}

integer() { case "$2" in '' | *[!0-9]*) refuse "$1 precisa ser um inteiro: '$2'." ;; esac; }

# ------------------------------------------------------------ the caps
integer BURN_IN_RATE "$RATE"
integer BURN_IN_MAX_VUS "$MAX_VUS"
integer BURN_IN_PROBE_EVERY "$PROBE_EVERY"
integer BURN_IN_PROBE_FLOOR_MS "$PROBE_FLOOR_MS"

[ "$RATE" -ge 1 ] && [ "$RATE" -le "$MAX_RATE" ] \
  || refuse "BURN_IN_RATE=$RATE: na staging o teto é $MAX_RATE req/s (a VPS é a mesma da produção)."
[ "$MAX_VUS" -ge 1 ] && [ "$MAX_VUS" -le "$MAX_SOCKETS" ] \
  || refuse "BURN_IN_MAX_VUS=$MAX_VUS: o teto é $MAX_SOCKETS sockets."

case "$DURATION" in
  *[!0-9]*m | m) refuse "BURN_IN_DURATION inválida: '$DURATION' (use 90s ou 10m)." ;;
  *m) SECONDS_PLANNED=$((${DURATION%m} * 60)) ;;
  *[!0-9]*s | s) refuse "BURN_IN_DURATION inválida: '$DURATION' (use 90s ou 10m)." ;;
  *s) SECONDS_PLANNED="${DURATION%s}" ;;
  *) refuse "BURN_IN_DURATION inválida: '$DURATION' (use 90s ou 10m)." ;;
esac

[ "$SECONDS_PLANNED" -ge 1 ] && [ "$SECONDS_PLANNED" -le "$MAX_SECONDS" ] \
  || refuse "BURN_IN_DURATION=$DURATION: o teto é 10 minutos."

# ------------------------------------------------------------ the target
host="$(printf '%s' "$HOST" | tr '[:upper:]' '[:lower:]')"

case "$host" in
  api.intrajetto.com | www.intrajetto.com | intrajetto.com)
    refuse "$HOST é a produção: o burn-in só roda contra a staging."
    ;;
esac

printf '%s' "$host" | grep -Eq '(^|[.-])staging([.-]|$)' \
  || refuse "$HOST não é um host de staging (precisa de um rótulo \"staging\")."

case "$SCHEME" in http | https) ;; *) refuse "BURN_IN_SCHEME precisa ser http ou https." ;; esac

# ------------------------------------------------------------ the window
read -r weekday day hour minute <<< "$(date -u '+%u %d %H %M')"
now=$((10#$hour * 60 + 10#$minute))
ends=$((now + (SECONDS_PLANNED + 119) / 60 + 2))

[ "$weekday" != "7" ] || refuse "Domingo é a janela do histórico (docs/operacao/jobs.md): rode de segunda a sábado."
[ "$day" != "01" ] || refuse "O dia 1 é do ensaio de restauração (docs/operacao/jobs.md): rode noutro dia."
[ "$now" -ge "$WINDOW_FROM" ] && [ "$ends" -le "$WINDOW_TO" ] \
  || refuse "Fora da janela de carga: só das 06:00 às 08:00 UTC (03:00–05:00 BRT), terminando antes das 08:00. Agora: ${hour}:${minute} UTC."

[ -n "${FIXTURE_ADMIN_EMAIL:-}" ] && [ -n "${FIXTURE_ADMIN_PASSWORD:-}" ] \
  || refuse "Defina FIXTURE_ADMIN_EMAIL e FIXTURE_ADMIN_PASSWORD (o administrador de 'Carga (staging)')."

command -v docker > /dev/null 2>&1 || refuse "docker não encontrado: rode no host da VPS."
command -v vmstat > /dev/null 2>&1 || refuse "vmstat não encontrado (pacote procps)."
command -v curl > /dev/null 2>&1 || refuse "curl não encontrado."

docker network inspect "$NETWORK" > /dev/null 2>&1 || refuse "A rede $NETWORK não existe aqui: rode no host do Dokploy."

EDGE_IP="$(docker inspect --format "{{(index .NetworkSettings.Networks \"$NETWORK\").IPAddress}}" "$EDGE" 2> /dev/null)"
[ -n "$EDGE_IP" ] || refuse "O Traefik ($EDGE) não está na rede $NETWORK."

# ------------------------------------------------------------ teardown
WORK="$(mktemp -d "${TMPDIR:-/tmp}/$NAME.XXXXXX")"
VMSTAT_PID=""
LOAD_PID=""

cleanup() {
  [ -n "$VMSTAT_PID" ] && kill "$VMSTAT_PID" 2> /dev/null
  docker rm -f "$NAME-k6" "$NAME-fixture" > /dev/null 2>&1
  rm -rf "$WORK"
}

trap cleanup EXIT
trap 'exit 130' INT TERM

# ------------------------------------------------------------ the fixture
echo "[burn-in] fixture: 'Carga (staging)' em $SCHEME://$HOST (Traefik $EDGE_IP)"

CONTEXT="$(docker run --rm -i --name "$NAME-fixture" --cpus 0.5 --memory 256m \
  --network "$NETWORK" --add-host "$HOST:$EDGE_IP" \
  -e "FIXTURE_BASE_URL=$SCHEME://$HOST" -e FIXTURE_ADMIN_EMAIL -e FIXTURE_ADMIN_PASSWORD \
  -e FIXTURE_DRIVERS -e FIXTURE_STOPS \
  "$NODE_IMAGE" node --input-type=module - < "$HERE/staging-fixture.mjs")"
fixture=$?

case "$fixture" in
  0) ;;
  2) refuse "a fixture recusou (veja a mensagem acima)." ;;
  *) refuse "a fixture falhou (saída $fixture)." ;;
esac

export ROLLING_CONTEXT_JSON="$CONTEXT"

# ------------------------------------------------------------ the probes
RESOLVE=()
if [ -n "$PROBE_RESOLVE" ]; then
  probe_host="$(printf '%s' "$PROBE_URL" | sed -E 's#^[a-z]+://([^/:]+).*#\1#')"
  case "$PROBE_URL" in https://*) probe_port=443 ;; *) probe_port=80 ;; esac
  RESOLVE=(--resolve "$probe_host:$probe_port:$PROBE_RESOLVE")
fi

# One sample: "<status> <milliseconds>".
probe() {
  curl -s -o /dev/null --max-time 5 "${RESOLVE[@]}" -w '%{http_code} %{time_total}' "$PROBE_URL" 2> /dev/null \
    | awk '{ printf "%s %d\n", $1, $2 * 1000 }'
}

# p95 of the last 12 samples that answered 200.
p95() {
  awk '$1 == 200 { print $2 }' "$WORK/probe.log" | tail -n 12 | sort -n \
    | awk '{ v[NR] = $1 } END { if (NR == 0) { print 0; exit } i = int(NR * 0.95 + 0.999); if (i > NR) i = NR; print v[i] }'
}

: > "$WORK/probe.log"
for _ in 1 2 3 4 5 6; do
  probe >> "$WORK/probe.log"
  sleep 2
done

if awk '$1 != 200 { bad = 1 } END { exit bad ? 0 : 1 }' "$WORK/probe.log"; then
  refuse "a readiness da produção já falha antes da carga: não comece. ($(tr '\n' ' ' < "$WORK/probe.log"))"
fi

BASE="$(p95)"
LIMIT=$((BASE * 2))
[ "$LIMIT" -ge "$PROBE_FLOOR_MS" ] || LIMIT="$PROBE_FLOOR_MS"
: > "$WORK/probe.log"

echo "[burn-in] base da readiness da produção: p95 ${BASE} ms; aborta acima de ${LIMIT} ms ou com 3 falhas"

vmstat "$PROBE_EVERY" > "$WORK/vmstat.log" 2> /dev/null &
VMSTAT_PID=$!

# The newest vmstat sample: "<iowait> <steal>". The first data line is the
# average since boot, not now: skipped.
host_pressure() {
  awk '
    $0 ~ / wa / || $0 ~ / wa$/ { for (i = 1; i <= NF; i++) { if ($i == "wa") wa = i; if ($i == "st") st = i } next }
    wa && $1 ~ /^[0-9]+$/ { rows++; if (rows > 1) last = $wa " " (st ? $st : 0) }
    END { print last }
  ' "$WORK/vmstat.log"
}

abort() {
  echo "[burn-in] ABORTADO: $*" >&2
  docker stop -t 5 "$NAME-k6" > /dev/null 2>&1
  [ -n "$LOAD_PID" ] && wait "$LOAD_PID" 2> /dev/null
  exit 3
}

# ------------------------------------------------------------ the load
echo "[burn-in] k6: $RATE req/s por $DURATION, até $MAX_VUS sockets (fiação e rolling, nunca capacidade)"

docker run --rm -i --name "$NAME-k6" --cpus 0.5 --memory 256m \
  --network "$NETWORK" --add-host "$HOST:$EDGE_IP" \
  -e "ROLLING_BASE_URL=$SCHEME://$HOST" -e "ROLLING_RATE=$RATE" \
  -e "ROLLING_DURATION=$DURATION" -e "ROLLING_MAX_VUS=$MAX_VUS" -e ROLLING_CONTEXT_JSON \
  "$K6_IMAGE" run --quiet - < "$HERE/rolling.js" > "$WORK/k6.log" 2>&1 &
LOAD_PID=$!

while kill -0 "$LOAD_PID" 2> /dev/null; do
  probe >> "$WORK/probe.log"

  failures="$(awk '$1 != 200' "$WORK/probe.log" | wc -l | tr -d ' ')"
  [ "$failures" -lt 3 ] || abort "a readiness da produção falhou $failures vezes."

  samples="$(awk '$1 == 200' "$WORK/probe.log" | wc -l | tr -d ' ')"
  if [ "$samples" -ge 4 ]; then
    now_p95="$(p95)"
    [ "$now_p95" -le "$LIMIT" ] || abort "a readiness da produção subiu para p95 ${now_p95} ms (base ${BASE} ms, teto ${LIMIT} ms)."
  fi

  read -r iowait steal <<< "$(host_pressure)"
  if [ -n "${iowait:-}" ]; then
    [ "$iowait" -le 20 ] || abort "iowait do host em ${iowait}% (teto 20%)."
    [ "${steal:-0}" -le 10 ] || abort "steal do host em ${steal}% (teto 10%)."
  fi

  sleep "$PROBE_EVERY"
done

wait "$LOAD_PID"
status=$?

grep -E 'rolling_(5xx|transport_errors|unexpected|throttled)|http_reqs|✗' "$WORK/k6.log" | sed 's/^/  /'

if [ "$status" -ne 0 ]; then
  echo "[burn-in] REPROVADO: respostas 5xx, sem resposta ou fora do esperado (k6 saiu com $status)." >&2
  tail -n 30 "$WORK/k6.log" >&2
  exit 1
fi

echo "[burn-in] aprovado: 0 respostas 5xx; readiness da produção p95 $(p95) ms (base ${BASE} ms)."
exit 0
