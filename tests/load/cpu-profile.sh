#!/usr/bin/env bash
#
# Where the API's CPU goes under load (plano-escala LOAD-10): a V8 CPU
# profile of every api replica of the harness while load.js runs, read by
# tests/load/lib/cpuprofile-top.mjs into the top functions and packages.
# It is what guides the cuts of F4-07, each then judged by cpu-abba.sh.
#
#   PROFILE_MATCH='ensureAuthenticated|loadSession' bash tests/load/cpu-profile.sh
#
# Before it, the harness is up and seeded (tests/load/README.md, "Como
# rodar"); run it with the same variables as the harness' `up`.
#
#   1. recreates the api replicas with PROFILE_IMAGE and
#      LOAD_API_NODE_FLAGS="--cpu-prof ...", which only the api's
#      NODE_OPTIONS reads (compose.load.yaml);
#   2. waits until each answers its readiness, warms up with load.js and
#      runs it at PROFILE_RATE for PROFILE_DURATION_SECONDS;
#   3. stops the replicas (docker stop -t 40: the API's graceful shutdown
#      ends in process.exit, and Node writes the profile on its way out),
#      copies each replica's profile out and prints the top of the measured
#      window, the boot and the shutdown left out;
#   4. recreates the replicas without the flag, with the same image, even
#      when a step failed.
#
# The profile is the main thread's, sampled every PROFILE_INTERVAL_US. Its
# CPU per request is a cross-check, not the bench's number: that one is the
# cgroup's, in cpu-abba.sh, which also sees the threads.
#
# Environment (optional):
#   PROFILE_IMAGE             the api's image (LOAD_API_IMAGE, or trajetto-api:load)
#   PROFILE_RATE              load.js operations per second (60)
#   PROFILE_DURATION_SECONDS  the profiled window (120)
#   PROFILE_WARMUP_SECONDS    load before the window (20)
#   PROFILE_INTERVAL_US       the sampling interval (1000)
#   PROFILE_TOP               rows of each table (25)
#   PROFILE_MATCH             a regex: the share of the CPU under it
#   PROFILE_READY_TIMEOUT_SECONDS  how long the replicas may take (180)
#   PROFILE_WORK              the raw files (tests/load/results/cpu-profile-<…>)
#   and lib/bench.sh's: LOAD_ENV_FILE, LOAD_EXTRA_ENV_FILES, LOAD_PROJECT.
#
# Exits 0 with the top printed (and in <work>/top.md), 2 when it refused to
# start or a step failed.
set -u

export MSYS_NO_PATHCONV=1

BENCH_NAME="cpu-profile"
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/bench.sh
. "$HERE/lib/bench.sh"

IMAGE="${PROFILE_IMAGE:-${LOAD_API_IMAGE:-trajetto-api:load}}"
RATE="${PROFILE_RATE:-60}"
DURATION="${PROFILE_DURATION_SECONDS:-120}"
WARMUP="${PROFILE_WARMUP_SECONDS:-20}"
INTERVAL="${PROFILE_INTERVAL_US:-1000}"
TOP="${PROFILE_TOP:-25}"
MATCH="${PROFILE_MATCH:-}"
READY_TIMEOUT="${PROFILE_READY_TIMEOUT_SECONDS:-180}"
PROFILE_DIR="/tmp/cpu-prof"

for pair in "PROFILE_RATE=$RATE" "PROFILE_DURATION_SECONDS=$DURATION" "PROFILE_WARMUP_SECONDS=$WARMUP" \
  "PROFILE_INTERVAL_US=$INTERVAL" "PROFILE_TOP=$TOP" "PROFILE_READY_TIMEOUT_SECONDS=$READY_TIMEOUT"; do
  bench_is_count "${pair#*=}" || bench_refuse "${pair%%=*} precisa ser um número inteiro: '${pair#*=}'."
done
[ "$RATE" -gt 0 ] && [ "$DURATION" -gt 0 ] && [ "$INTERVAL" -gt 0 ] ||
  bench_refuse "PROFILE_RATE, PROFILE_DURATION_SECONDS e PROFILE_INTERVAL_US precisam ser maiores que zero."

bench_guard_local
bench_compose_init

docker image inspect --format '{{.Id}}' "$IMAGE" > /dev/null 2>&1 ||
  bench_refuse "A imagem $IMAGE não existe nesta máquina: construa antes ou passe PROFILE_IMAGE."
[ -n "$(bench_containers postgres)" ] ||
  bench_refuse "O harness ($BENCH_PROJECT) não está de pé: suba e rode o seed antes (tests/load/README.md, 'Como rodar')."
[ -f "$BENCH_CONTEXT_FILE" ] ||
  bench_refuse "Falta tests/load/fixtures/load-context.json: rode o seed antes (tests/load/README.md, passo 2)."

WORK="${PROFILE_WORK:-$HERE/results/cpu-profile-$(date -u +%Y%m%d-%H%M%S)}"
mkdir -p "$WORK" || bench_refuse "Não consegui criar $WORK."

failed() {
  echo "[cpu-profile] $*" >&2
  exit 2
}

# The replicas go back to the image without the profiler, whatever happened.
restore() {
  bench_say "réplicas de volta sem o perfil ($IMAGE)"
  LOAD_API_IMAGE="$IMAGE" LOAD_API_NODE_FLAGS="" bench_compose up -d --no-deps --no-build \
    --force-recreate api > "$WORK/restore.log" 2>&1 ||
    echo "[cpu-profile] AVISO: as réplicas não voltaram; veja $WORK/restore.log e suba o harness de novo." >&2
}

trap restore EXIT

bench_say "réplicas com o perfil de CPU ($IMAGE, a cada $INTERVAL µs)"
LOAD_API_IMAGE="$IMAGE" \
  LOAD_API_NODE_FLAGS="--cpu-prof --cpu-prof-dir=$PROFILE_DIR --cpu-prof-interval=$INTERVAL" \
  bench_compose up -d --no-deps --no-build --force-recreate --wait --wait-timeout "$READY_TIMEOUT" api \
  > "$WORK/up.log" 2>&1 || failed "as réplicas não subiram com o perfil (veja $WORK/up.log)."
bench_wait_ready "$READY_TIMEOUT" || failed "as réplicas não ficaram prontas."

replicas="$(bench_containers api)"

if [ "$WARMUP" -gt 0 ]; then
  bench_k6 warmup "$RATE" "$WARMUP" "$WORK"
  status=$?
  [ "$status" = 0 ] || [ "$status" = 99 ] || failed "o aquecimento saiu com $status (veja $WORK/warmup.log)."
fi

bench_say "carga: $RATE operações/s por $DURATION s"
bench_k6 k6 "$RATE" "$DURATION" "$WORK"
status=$?
[ "$status" = 0 ] || [ "$status" = 99 ] || failed "o k6 saiu com $status (veja $WORK/k6.log)."

# From the end of the load to the end of each profile: the shutdown. An
# upper bound (docker stop returns after the exit), so the cut never keeps
# the shutdown in the window.
loaded="$(date +%s)"
# shellcheck disable=SC2086
docker stop -t 40 $replicas > /dev/null || failed "as réplicas não pararam."
tail_seconds=$(($(date +%s) - loaded + 1))

profiles=()
for c in $replicas; do
  mkdir -p "$WORK/prof-$c"
  docker cp "$c:$PROFILE_DIR/." "$(bench_native "$WORK/prof-$c")" > /dev/null 2>&1 ||
    failed "não consegui copiar o perfil da réplica $c."

  # The server's profile is the largest: the entrypoint's
  # wait-for-postgres writes a small one of its own.
  largest="$(ls -S "$WORK/prof-$c"/*.cpuprofile 2> /dev/null | head -1)"
  [ -n "$largest" ] || failed "a réplica $c não escreveu perfil (ela saiu pelo process.exit?)."
  profiles+=("$(bench_native "$largest")")
done

requests="$(bench_requests_of "$WORK/k6.json")"
args=(--last "$DURATION" --skip-tail "$tail_seconds" --top "$TOP" --requests "$requests")
[ -z "$MATCH" ] || args+=(--match "$MATCH")

node "$(bench_native "$HERE/lib/cpuprofile-top.mjs")" "${args[@]}" "${profiles[@]}" > "$WORK/top.md" ||
  failed "não consegui ler os perfis (veja $WORK)."

cat "$WORK/top.md"
bench_say "perfis e resumo em $WORK"
