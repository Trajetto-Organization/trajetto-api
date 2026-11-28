#!/usr/bin/env bash
#
# The ABBA bench of CPU and statements per request (plano-escala LOAD-10),
# the method of docs/adr/0011-orm-prisma-6-7-8.md made a script: two images
# of the API, A and B, take turns on the SAME harness, in the order ABBAAB,
# each run on a fresh copy of the same database, and the report says how
# much CPU and how many Postgres statements one request costs in each.
#
#   ABBA_A_IMAGE=trajetto-api:antes ABBA_B_IMAGE=trajetto-api:depois \
#     ABBA_LABEL=sessao-num-statement bash tests/load/cpu-abba.sh
#
# Before it, the harness is up and seeded (tests/load/README.md, "Como
# rodar", steps 1 and 2): the database load_test as the seed left it is the
# model every run is copied from. Run it with the same variables as the
# harness' `up` (LOAD_REPLICAS, LOAD_API_ROLE...): the api is recreated with
# them on every run.
#
# Every run:
#   1. stops the API's containers (api, and worker/realtime when they run),
#      puts back load_test from the model (load_abba_template, made from
#      load_test on the first session; ABBA_FRESH_TEMPLATE=1 after a new
#      seed) and empties the harness' Redis, so no run inherits the writes,
#      the caches or the rate limits of the one before;
#   2. recreates the api replicas with the run's image and waits until each
#      answers its readiness;
#   3. warms up with load.js (ABBA_WARMUP_SECONDS) and measures the idle
#      background (ABBA_IDLE_SECONDS: the queues' polling, the cron, the
#      samplers) with no load;
#   4. resets pg_stat_statements, reads the CPU of each container from its
#      cgroup (cpu.stat), runs load.js at ABBA_RATE operations/s for
#      ABBA_DURATION_SECONDS, and reads both again.
#
# CPU per request is the api containers' CPU in the window over k6's
# requests, as the ADR measured it (with PROCESS_ROLE=all the queue work is
# in it too); statements per request are pg_stat_statements' calls in
# load_test over the same requests (BEGIN and COMMIT included). The
# report also gives both net of the idle background, the Postgres' own CPU
# and p50/p95/p99.
#
# The verdict (tests/load/lib/abba-report.mjs):
#   - A and B the same image (the control, A=B): |Δ| < 5% in CPU and in
#     statements, or the bench is too noisy for any cut to be judged on it;
#   - two images (a cut, F4-07): B keeps the cut only with CPU down by 2% or
#     more and the p95 no more than 5% worse;
#   - the wave 15 target (≤ 6.0 ms and ≤ 7 statements per request) for B,
#     indicative on the bench.
#
# The report goes to docs/desempenho/bancada/<date>-<label>.md (a second one
# the same day is -2, -3...); the raw files stay in tests/load/results.
# The api is left on the last run's image and load_test as that run left it.
#
# Environment (optional unless marked):
#   ABBA_A_IMAGE, ABBA_B_IMAGE   (required) the two images, built locally;
#                                the same image twice is the control
#   ABBA_LABEL                   the report's name (abba)
#   ABBA_ORDER                   the order (ABBAAB); only A and B, as many
#                                of each, at least two of each
#   ABBA_RATE                    load.js operations per second (60, the ADR's)
#   ABBA_DURATION_SECONDS        the measured window of each run (120)
#   ABBA_WARMUP_SECONDS          load before the window, not measured (20)
#   ABBA_IDLE_SECONDS            the idle background's window (15; 0 skips it)
#   ABBA_SETTLE_SECONDS          pause after the replicas are ready (5)
#   ABBA_READY_TIMEOUT_SECONDS   how long the replicas may take (180)
#   ABBA_FRESH_TEMPLATE          1 makes the model again from load_test
#   ABBA_REPORT_DIR              where the report goes (docs/desempenho/bancada)
#   ABBA_WORK                    the raw files (tests/load/results/abba-<…>)
#   and lib/bench.sh's: LOAD_ENV_FILE, LOAD_EXTRA_ENV_FILES, LOAD_PROJECT.
#
# Exits 0 when the verdict passes (the control is quiet, or the cut stays),
# 1 when it does not, 2 when it refused to start or a run failed.
set -u

export MSYS_NO_PATHCONV=1

BENCH_NAME="abba"
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/bench.sh
. "$HERE/lib/bench.sh"

A_IMAGE="${ABBA_A_IMAGE:-}"
B_IMAGE="${ABBA_B_IMAGE:-}"
ORDER="${ABBA_ORDER:-ABBAAB}"
RATE="${ABBA_RATE:-60}"
DURATION="${ABBA_DURATION_SECONDS:-120}"
WARMUP="${ABBA_WARMUP_SECONDS:-20}"
IDLE="${ABBA_IDLE_SECONDS:-15}"
SETTLE="${ABBA_SETTLE_SECONDS:-5}"
READY_TIMEOUT="${ABBA_READY_TIMEOUT_SECONDS:-180}"
LABEL="$(printf '%s' "${ABBA_LABEL:-abba}" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed -E 's/-+/-/g; s/^-//; s/-$//')"
REPORT_DIR="${ABBA_REPORT_DIR:-$BENCH_ROOT/docs/desempenho/bancada}"
TEMPLATE_DB="load_abba_template"
DB="load_test"

# ------------------------------------------------------------ before docker
[ -n "$A_IMAGE" ] && [ -n "$B_IMAGE" ] ||
  bench_refuse "Defina ABBA_A_IMAGE e ABBA_B_IMAGE (as duas imagens; a mesma duas vezes é o controle A=B)."

printf '%s' "$ORDER" | grep -Eq '^[AB]+$' || bench_refuse "ABBA_ORDER só tem A e B: '$ORDER'."
count_a="$(printf '%s' "$ORDER" | tr -cd 'A' | wc -c | tr -d ' ')"
count_b="$(printf '%s' "$ORDER" | tr -cd 'B' | wc -c | tr -d ' ')"
[ "$count_a" = "$count_b" ] && [ "$count_a" -ge 2 ] ||
  bench_refuse "ABBA_ORDER precisa do mesmo número de A e de B, pelo menos dois de cada: '$ORDER'."

for pair in "ABBA_RATE=$RATE" "ABBA_DURATION_SECONDS=$DURATION" "ABBA_WARMUP_SECONDS=$WARMUP" \
  "ABBA_IDLE_SECONDS=$IDLE" "ABBA_SETTLE_SECONDS=$SETTLE" "ABBA_READY_TIMEOUT_SECONDS=$READY_TIMEOUT"; do
  bench_is_count "${pair#*=}" || bench_refuse "${pair%%=*} precisa ser um número inteiro: '${pair#*=}'."
done
[ "$RATE" -gt 0 ] && [ "$DURATION" -gt 0 ] || bench_refuse "ABBA_RATE e ABBA_DURATION_SECONDS precisam ser maiores que zero."
[ -n "$LABEL" ] || bench_refuse "ABBA_LABEL precisa de letras ou números."

bench_guard_local
bench_compose_init

# ------------------------------------------------------------ the harness
A_ID="$(docker image inspect --format '{{.Id}}' "$A_IMAGE" 2> /dev/null)" ||
  bench_refuse "A imagem A ($A_IMAGE) não existe nesta máquina: construa antes (docker build -t $A_IMAGE .)."
B_ID="$(docker image inspect --format '{{.Id}}' "$B_IMAGE" 2> /dev/null)" ||
  bench_refuse "A imagem B ($B_IMAGE) não existe nesta máquina: construa antes (docker build -t $B_IMAGE .)."

PG="$(bench_containers postgres | head -1)"
REDIS="$(bench_containers redis | head -1)"
[ -n "$PG" ] && [ -n "$REDIS" ] ||
  bench_refuse "O harness ($BENCH_PROJECT) não está de pé: suba e rode o seed antes (tests/load/README.md, 'Como rodar')."
[ -f "$BENCH_CONTEXT_FILE" ] ||
  bench_refuse "Falta tests/load/fixtures/load-context.json: rode o seed antes (tests/load/README.md, passo 2)."

# On the maintenance database, so what it asks never counts in load_test's
# statements; NOTICEs (a DROP ... IF EXISTS of nothing) stay out of the log.
psql_admin() {
  docker exec -i -e "PGOPTIONS=-c client_min_messages=warning" "$PG" \
    psql -U "$BENCH_PG_USER" -d postgres -v ON_ERROR_STOP=1 -X -q -At "$@"
}

case "$(psql_admin -c 'SHOW shared_preload_libraries' 2> /dev/null)" in
  *pg_stat_statements*) ;;
  *) bench_refuse "O Postgres do harness não pré-carrega o pg_stat_statements (o compose.load.yaml o faz): suba o harness deste repositório." ;;
esac

[ "$(psql_admin -c "SELECT 1 FROM pg_database WHERE datname = '$DB'")" = "1" ] ||
  bench_refuse "O banco $DB não existe no harness: suba e rode o seed antes."

psql_admin -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements' > /dev/null ||
  bench_refuse "Não consegui criar o pg_stat_statements no banco postgres do harness."

WORK="${ABBA_WORK:-$HERE/results/abba-$(date -u +%Y%m%d-%H%M%S)}"
mkdir -p "$WORK" "$REPORT_DIR" || bench_refuse "Não consegui criar $WORK e $REPORT_DIR."

STOPPED_OTHERS=""

# Stops what holds load_test: the api replicas and, when they run, the
# worker and the realtime (started again by `start_others`).
stop_app() {
  local api others
  api="$(bench_containers api)"
  others="$(bench_containers worker) $(bench_containers realtime)"
  STOPPED_OTHERS="$(echo "$others" | xargs)"
  # shellcheck disable=SC2086
  [ -z "$api$STOPPED_OTHERS" ] || docker stop -t 40 $api $STOPPED_OTHERS > /dev/null
}

start_others() {
  # shellcheck disable=SC2086
  [ -z "$STOPPED_OTHERS" ] || docker start $STOPPED_OTHERS > /dev/null
}

# "calls exec_ms rows" of load_test since the last reset.
pgss_totals() {
  psql_admin -F ' ' -c "SELECT coalesce(sum(calls), 0), coalesce(round(sum(total_exec_time)::numeric, 3), 0), coalesce(sum(rows), 0)
    FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = '$DB')"
}

pgss_reset() { psql_admin -c 'SELECT pg_stat_statements_reset()' > /dev/null; }

failed_run() {
  echo "[abba] a corrida $1 falhou: $2" >&2
  echo "[abba] os arquivos brutos estão em $WORK" >&2
  exit 2
}

# ------------------------------------------------------------ the model
template="$(psql_admin -c "SELECT 1 FROM pg_database WHERE datname = '$TEMPLATE_DB'")"

if [ "$template" != "1" ] || [ "${ABBA_FRESH_TEMPLATE:-0}" = "1" ]; then
  bench_say "modelo do banco: $TEMPLATE_DB a partir de $DB (o seed como está)"
  stop_app
  psql_admin -c "DROP DATABASE IF EXISTS $TEMPLATE_DB" > /dev/null &&
    psql_admin -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB' AND pid <> pg_backend_pid()" > /dev/null &&
    psql_admin -c "CREATE DATABASE $TEMPLATE_DB TEMPLATE $DB" > /dev/null &&
    psql_admin -c "COMMENT ON DATABASE $TEMPLATE_DB IS 'abba $(date -u +%Y-%m-%dT%H:%MZ)'" > /dev/null ||
    bench_refuse "Não consegui copiar $DB para $TEMPLATE_DB."
  start_others
fi

TEMPLATE_MADE="$(psql_admin -c "SELECT coalesce(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datname = '$TEMPLATE_DB'")"

# ------------------------------------------------------------ the facts
{
  printf '{"label":"%s","order":"%s","aImage":"%s","aId":"%s","bImage":"%s","bId":"%s",' \
    "$LABEL" "$ORDER" "$A_IMAGE" "$A_ID" "$B_IMAGE" "$B_ID"
  printf '"rate":%s,"durationSeconds":%s,"warmupSeconds":%s,"idleSeconds":%s,' \
    "$RATE" "$DURATION" "$WARMUP" "$IDLE"
  printf '"commit":"%s","host":"%s","nproc":"%s","dockerCpus":"%s","template":"%s","date":"%s"}\n' \
    "$(bench_commit)" "$(hostname 2> /dev/null || echo '?')" \
    "$(nproc 2> /dev/null || getconf _NPROCESSORS_ONLN 2> /dev/null || echo '?')" \
    "$(docker info --format '{{.NCPU}}' 2> /dev/null || echo '?')" \
    "$TEMPLATE_MADE" "$(date -u +%Y-%m-%d)"
} > "$WORK/meta.json"

# ------------------------------------------------------------ the runs
total="${#ORDER}"
n=0

while [ "$n" -lt "$total" ]; do
  variant="${ORDER:$n:1}"
  n=$((n + 1))

  if [ "$variant" = "A" ]; then image="$A_IMAGE"; else image="$B_IMAGE"; fi

  bench_say "corrida $n/$total: $variant ($image)"

  stop_app
  psql_admin -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" > /dev/null &&
    psql_admin -c "CREATE DATABASE $DB TEMPLATE $TEMPLATE_DB" > /dev/null ||
    failed_run "$n" "não consegui copiar $TEMPLATE_DB para $DB."
  docker exec "$REDIS" redis-cli FLUSHALL > /dev/null || failed_run "$n" "não consegui esvaziar o Redis do harness."
  start_others

  LOAD_API_IMAGE="$image" bench_compose up -d --no-deps --no-build --force-recreate \
    --wait --wait-timeout "$READY_TIMEOUT" api > "$WORK/up-$n.log" 2>&1 ||
    failed_run "$n" "as réplicas com $image não subiram (veja $WORK/up-$n.log)."
  bench_wait_ready "$READY_TIMEOUT" || failed_run "$n" "as réplicas com $image não ficaram prontas."

  # The containers of the run, once: the reads in the window are cgroup
  # reads only.
  api_ids="$(bench_containers api)"
  worker_ids="$(bench_containers worker)"
  realtime_ids="$(bench_containers realtime)"
  replicas="$(echo "$api_ids" | wc -l | tr -d ' ')"
  first="$(echo "$api_ids" | head -1)"
  role="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$first" 2> /dev/null | sed -n 's/^PROCESS_ROLE=//p' | head -1)"
  cpuset="$(docker inspect --format '{{.HostConfig.CpusetCpus}}' "$first" 2> /dev/null || true)"

  sleep "$SETTLE"

  if [ "$WARMUP" -gt 0 ]; then
    bench_k6 "warmup-$n" "$RATE" "$WARMUP" "$WORK"
    status=$?
    [ "$status" = 0 ] || [ "$status" = 99 ] || failed_run "$n" "o aquecimento saiu com $status (veja $WORK/warmup-$n.log)."
  fi

  idle_usec=0
  idle_calls=0

  if [ "$IDLE" -gt 0 ]; then
    pgss_reset || failed_run "$n" "não consegui zerar o pg_stat_statements."
    read -r before _ _ < <(bench_cpu_sum "$api_ids") || failed_run "$n" "não li a CPU das réplicas."
    sleep "$IDLE"
    read -r after _ _ < <(bench_cpu_sum "$api_ids") || failed_run "$n" "não li a CPU das réplicas."
    read -r idle_calls _ _ < <(pgss_totals)
    idle_usec=$((after - before))
  fi

  pgss_reset || failed_run "$n" "não consegui zerar o pg_stat_statements."
  started="$(date +%s)"
  read -r api0 user0 sys0 < <(bench_cpu_sum "$api_ids") || failed_run "$n" "não li a CPU das réplicas."
  read -r pg0 _ _ < <(bench_cpu_sum "$PG") || failed_run "$n" "não li a CPU do Postgres."
  read -r worker0 _ _ < <(bench_cpu_sum "$worker_ids")
  read -r realtime0 _ _ < <(bench_cpu_sum "$realtime_ids")

  bench_k6 "k6-$n" "$RATE" "$DURATION" "$WORK"
  k6_exit=$?

  read -r api1 user1 sys1 < <(bench_cpu_sum "$api_ids") || failed_run "$n" "não li a CPU das réplicas."
  read -r pg1 _ _ < <(bench_cpu_sum "$PG") || failed_run "$n" "não li a CPU do Postgres."
  read -r worker1 _ _ < <(bench_cpu_sum "$worker_ids")
  read -r realtime1 _ _ < <(bench_cpu_sum "$realtime_ids")
  ended="$(date +%s)"

  [ "$k6_exit" = 0 ] || [ "$k6_exit" = 99 ] || failed_run "$n" "o k6 saiu com $k6_exit (veja $WORK/k6-$n.log)."
  # A counter that went back is a cgroup that started over: a replica
  # restarted inside the window, and the window measures nothing.
  [ "$api1" -ge "$api0" ] && [ "$pg1" -ge "$pg0" ] ||
    failed_run "$n" "a CPU lida voltou para trás: um contêiner reiniciou durante a janela."

  read -r calls exec_ms rows < <(pgss_totals) || failed_run "$n" "não li o pg_stat_statements."
  psql_admin -F "$(printf '\t')" -c "SELECT calls, round(total_exec_time::numeric, 1), left(regexp_replace(query, '\s+', ' ', 'g'), 160)
    FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = '$DB')
    ORDER BY calls DESC LIMIT 15" > "$WORK/pgss-top-$n.tsv" 2> /dev/null || true

  memory="$(docker exec "$first" sh -c 'p=$(sed -n "s/^0:://p" /proc/self/cgroup 2>/dev/null); cat "/sys/fs/cgroup${p%/}/memory.current" 2>/dev/null || cat /sys/fs/cgroup/memory.current' 2> /dev/null | tr -d '\r' || true)"
  bench_is_count "$memory" || memory=0

  printf '{"n":%s,"variant":"%s","image":"%s","replicas":%s,"role":"%s","cpuset":"%s","k6Exit":%s,"wallSeconds":%s,' \
    "$n" "$variant" "$image" "${replicas:-0}" "${role:-?}" "$cpuset" "$k6_exit" "$((ended - started))" > "$WORK/run-$n.json"
  printf '"idle":{"seconds":%s,"apiUsec":%s,"calls":%s},' "$IDLE" "$idle_usec" "${idle_calls:-0}" >> "$WORK/run-$n.json"
  printf '"cpu":{"apiUsec":%s,"apiUserUsec":%s,"apiSystemUsec":%s,"postgresUsec":%s,"workerUsec":%s,"realtimeUsec":%s},' \
    "$((api1 - api0))" "$((user1 - user0))" "$((sys1 - sys0))" "$((pg1 - pg0))" \
    "$((${worker1:-0} - ${worker0:-0}))" "$((${realtime1:-0} - ${realtime0:-0}))" >> "$WORK/run-$n.json"
  printf '"pgss":{"calls":%s,"execMs":%s,"rows":%s},"apiMemoryBytes":%s}\n' \
    "${calls:-0}" "${exec_ms:-0}" "${rows:-0}" "$memory" >> "$WORK/run-$n.json"

  bench_say "corrida $n: CPU da api $(((api1 - api0) / 1000)) ms, $calls statements na janela"
done

# ------------------------------------------------------------ the report
node "$(bench_native "$HERE/lib/abba-report.mjs")" "$(bench_native "$WORK")" "$(bench_native "$REPORT_DIR")"
verdict=$?

bench_say "a api ficou com a imagem da última corrida ($image) e o $DB como ela o deixou; o modelo $TEMPLATE_DB fica para a próxima sessão."
exit "$verdict"
