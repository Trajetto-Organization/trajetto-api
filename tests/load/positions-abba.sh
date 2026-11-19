#!/usr/bin/env bash
#
# The ABBA of the GPS write path at the 5M gate's rate (plano-escala
# LOAD-11): positions-5m.js at 500 POST/s of 4 points, with the group
# commit and the session cache off (A) and on (B), in the order ABBA, on
# the SAME harness and the same image. Only the two variables change
# between the arms, through the api replicas' env file (LOAD_API_ENV_FILE):
#
#   A  POSITION_GROUP_COMMIT=off  SESSION_CACHE_TTL_MS=0   (production today)
#   B  POSITION_GROUP_COMMIT=on   SESSION_CACHE_TTL_MS=<POSITIONS_ABBA_CACHE_TTL_MS>
#
#   bash tests/load/positions-abba.sh
#
# Before it, the harness is up and seeded with the drivers of the step
# (tests/load/README.md, "Como rodar"; the 5m tier for the gate's
# number), without the ingest profile: the arms' variables reach the api
# replicas only, and positions-5m.js posts through Traefik to them.
#
# Every run:
#   1. recreates the api replicas with the arm's env file and waits until
#      each answers its readiness;
#   2. reads the database's commits (pg_stat_database.xact_commit), runs
#      positions-5m.js with the arm's tag and reads the commits again;
#   3. counts the rows of the run's window in driver_position_v2, against
#      the points the API answered 200 for ("0 ponto perdido");
#   4. sums the ops_sample of the window: position_group_commit (batches,
#      fallback flushes, breaker openings) and session_cache (hits,
#      misses).
#
# The verdict (tests/load/lib/verdicts.mjs, positions-abba): every run with
# no product failure and every stored point in the database; no breaker
# opening in B; B's p95 no more than 5% worse than A's. It also says what
# B gained: commits per POST and the p95, arm by arm. The session goes to
# <work>/session.json and the verdict to <work>/verdict.json.
#
# On the gate's target (wave 23) there is no harness to recreate: the owner
# flips the two variables on the target's Applications between the runs
# and runs positions-5m.js from the generator, as the README says.
#
# Environment (optional):
#   POSITIONS_ABBA_ORDER         the order (ABBA); only A and B, two of each at least
#   POSITIONS_ABBA_RATE          POST/s (500)
#   POSITIONS_ABBA_POINTS        points per POST (4)
#   POSITIONS_ABBA_DURATION      each run (10m)
#   POSITIONS_ABBA_CACHE_TTL_MS  B's session cache (15000, the env-schema's ceiling)
#   POSITIONS_ABBA_SETTLE_SECONDS  pause after the replicas are ready (10)
#   POSITIONS_ABBA_READY_TIMEOUT_SECONDS  how long the replicas may take (180)
#   POSITIONS_ABBA_WORK          the raw files (tests/load/results/positions-abba-<…>)
#   and lib/bench.sh's: LOAD_ENV_FILE, LOAD_EXTRA_ENV_FILES, LOAD_PROJECT.
#
# Exits 0 when the verdict passes, 1 when it does not, 2 when it refused to
# start or a run failed.
set -u

export MSYS_NO_PATHCONV=1

BENCH_NAME="positions-abba"
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/bench.sh
. "$HERE/lib/bench.sh"

ORDER="${POSITIONS_ABBA_ORDER:-ABBA}"
RATE="${POSITIONS_ABBA_RATE:-500}"
POINTS="${POSITIONS_ABBA_POINTS:-4}"
DURATION="${POSITIONS_ABBA_DURATION:-10m}"
CACHE_TTL_MS="${POSITIONS_ABBA_CACHE_TTL_MS:-15000}"
SETTLE="${POSITIONS_ABBA_SETTLE_SECONDS:-10}"
READY_TIMEOUT="${POSITIONS_ABBA_READY_TIMEOUT_SECONDS:-180}"
DB="load_test"

# ------------------------------------------------------------ before docker
printf '%s' "$ORDER" | grep -Eq '^[AB]+$' || bench_refuse "POSITIONS_ABBA_ORDER só tem A e B: '$ORDER'."
count_a="$(printf '%s' "$ORDER" | tr -cd 'A' | wc -c | tr -d ' ')"
count_b="$(printf '%s' "$ORDER" | tr -cd 'B' | wc -c | tr -d ' ')"
[ "$count_a" = "$count_b" ] && [ "$count_a" -ge 2 ] ||
  bench_refuse "POSITIONS_ABBA_ORDER precisa do mesmo número de A e de B, pelo menos dois de cada: '$ORDER'."

for pair in "POSITIONS_ABBA_RATE=$RATE" "POSITIONS_ABBA_POINTS=$POINTS" "POSITIONS_ABBA_CACHE_TTL_MS=$CACHE_TTL_MS" \
  "POSITIONS_ABBA_SETTLE_SECONDS=$SETTLE" "POSITIONS_ABBA_READY_TIMEOUT_SECONDS=$READY_TIMEOUT"; do
  bench_is_count "${pair#*=}" || bench_refuse "${pair%%=*} precisa ser um número inteiro: '${pair#*=}'."
done
[ "$RATE" -gt 0 ] && [ "$POINTS" -gt 0 ] || bench_refuse "POSITIONS_ABBA_RATE e POSITIONS_ABBA_POINTS precisam ser maiores que zero."
[ "$CACHE_TTL_MS" -ge 1 ] && [ "$CACHE_TTL_MS" -le 15000 ] ||
  bench_refuse "POSITIONS_ABBA_CACHE_TTL_MS vai de 1 a 15000 (o teto do env-schema): '$CACHE_TTL_MS'."
printf '%s' "$DURATION" | grep -Eq '^[0-9]+(s|m|h)$' || bench_refuse "POSITIONS_ABBA_DURATION no formato do k6 (600s, 10m): '$DURATION'."

bench_guard_local
bench_compose_init

# ------------------------------------------------------------ the harness
PG="$(bench_containers postgres | head -1)"
[ -n "$PG" ] || bench_refuse "O harness ($BENCH_PROJECT) não está de pé: suba e rode o seed antes (tests/load/README.md, 'Como rodar')."
[ -f "$BENCH_CONTEXT_FILE" ] ||
  bench_refuse "Falta tests/load/fixtures/load-context.json: rode o seed antes (tests/load/README.md, passo 2)."
[ -z "$(bench_containers ingest)" ] ||
  bench_refuse "O perfil ingest está de pé: as variáveis de cada braço chegam só às réplicas da api. Suba o harness sem --profile ingest."

psql_db() {
  docker exec -i -e "PGOPTIONS=-c client_min_messages=warning" "$PG" \
    psql -U "$BENCH_PG_USER" -d "$DB" -v ON_ERROR_STOP=1 -X -q -At "$@"
}

[ "$(psql_db -c 'SELECT 1')" = "1" ] || bench_refuse "O banco $DB não existe no harness: suba e rode o seed antes."

WORK="${POSITIONS_ABBA_WORK:-$HERE/results/positions-abba-$(date -u +%Y%m%d-%H%M%S)}"
mkdir -p "$WORK" || bench_refuse "Não consegui criar $WORK."

printf 'POSITION_GROUP_COMMIT=off\nSESSION_CACHE_TTL_MS=0\n' > "$WORK/arm-A.env"
printf 'POSITION_GROUP_COMMIT=on\nSESSION_CACHE_TTL_MS=%s\n' "$CACHE_TTL_MS" > "$WORK/arm-B.env"

failed_run() {
  echo "[$BENCH_NAME] a corrida $1 falhou: $2" >&2
  echo "[$BENCH_NAME] os arquivos brutos estão em $WORK" >&2
  exit 2
}

commits() { psql_db -c "SELECT xact_commit FROM pg_stat_database WHERE datname = '$DB'"; }

# ------------------------------------------------------------ the runs
total="${#ORDER}"
n=0
runs=""

while [ "$n" -lt "$total" ]; do
  arm="${ORDER:$n:1}"
  n=$((n + 1))
  id="$n-$arm"

  bench_say "corrida $n/$total: braço $arm ($(tr '\n' ' ' < "$WORK/arm-$arm.env"))"

  LOAD_API_ENV_FILE="$(bench_native "$WORK/arm-$arm.env")" bench_compose up -d --no-deps --no-build \
    --force-recreate --wait --wait-timeout "$READY_TIMEOUT" api > "$WORK/up-$id.log" 2>&1 ||
    failed_run "$n" "as réplicas do braço $arm não subiram (veja $WORK/up-$id.log)."
  bench_wait_ready "$READY_TIMEOUT" || failed_run "$n" "as réplicas do braço $arm não ficaram prontas."

  # The arm reached the replicas: the env file is read at their creation.
  first="$(bench_containers api | head -1)"
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$first" 2> /dev/null |
    grep -q "^POSITION_GROUP_COMMIT=$([ "$arm" = "A" ] && echo off || echo on)$" ||
    failed_run "$n" "as réplicas não receberam o POSITION_GROUP_COMMIT do braço $arm."

  sleep "$SETTLE"

  commits0="$(commits)"
  bench_is_count "$commits0" || failed_run "$n" "não li o pg_stat_database."

  bench_compose --profile k6 run --rm --no-deps \
    -v "$(bench_native "$WORK"):/results" \
    -e "POSITIONS_5M_RATE=$RATE" -e "POSITIONS_5M_POINTS=$POINTS" \
    -e "POSITIONS_5M_DURATION=$DURATION" -e "POSITIONS_5M_ARM=$arm" \
    k6 run --summary-export "/results/$id.json" /load/positions-5m.js \
    > "$WORK/$id.log" 2>&1 < /dev/null
  k6_exit=$?

  commits1="$(commits)"
  [ "$k6_exit" = 0 ] || [ "$k6_exit" = 99 ] || failed_run "$n" "o k6 saiu com $k6_exit (veja $WORK/$id.log)."

  # k6 logs the line in logfmt, its quotes escaped: they go first.
  window="$(grep -o 'POSITIONS_5M_WINDOW {[^}]*}' "$WORK/$id.log" | tail -1 | sed 's/^POSITIONS_5M_WINDOW //; s/\\"/"/g')"
  [ -n "$window" ] || failed_run "$n" "a cena não imprimiu a janela (veja $WORK/$id.log)."

  from="$(printf '%s' "$window" | sed -n 's/.*"from":"\([^"]*\)".*/\1/p')"
  to="$(printf '%s' "$window" | sed -n 's/.*"to":"\([^"]*\)".*/\1/p')"
  printf '%s' "$from$to" | grep -Eq '^[0-9TZ:.-]+$' || failed_run "$n" "a janela da cena não é de datas: '$window'."

  rows="$(psql_db -c "SELECT count(*) FROM driver_position_v2 WHERE recorded_at >= '$from'::timestamptz AT TIME ZONE 'UTC' AND recorded_at <= '$to'::timestamptz AT TIME ZONE 'UTC'")"
  bench_is_count "$rows" || failed_run "$n" "não contei os pontos da janela."

  # The process rows of the window, summed (the cluster row has neither).
  ops="$(psql_db -c "SELECT json_build_object(
      'batches', coalesce(sum((metrics->'position_group_commit'->>'batches')::bigint), 0),
      'fallbackFlushes', coalesce(sum((metrics->'position_group_commit'->>'fallback_flushes')::bigint), 0),
      'breakerOpens', coalesce(sum((metrics->'position_group_commit'->>'breaker_opens')::bigint), 0),
      'cacheHits', coalesce(sum((metrics->'session_cache'->>'hits')::bigint), 0),
      'cacheMisses', coalesce(sum((metrics->'session_cache'->>'misses')::bigint), 0))
    FROM ops_sample
    WHERE role <> 'cluster'
      AND ts >= '$from'::timestamptz AT TIME ZONE 'UTC'
      AND ts <= ('$to'::timestamptz + interval '1 minute') AT TIME ZONE 'UTC'")"
  [ -n "$ops" ] || ops='{}'

  printf '{"n":%s,"arm":"%s","summary":"%s.json","from":"%s","to":"%s","dbPoints":%s,"commits":%s,"ops":%s}\n' \
    "$n" "$arm" "$id" "$from" "$to" "$rows" "$((commits1 - commits0))" "$ops" > "$WORK/run-$id.json"
  runs="$runs $WORK/run-$id.json"

  bench_say "corrida $n: $rows pontos no banco, $((commits1 - commits0)) commits na janela"
done

# ------------------------------------------------------------ the verdict
# shellcheck disable=SC2086
node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const [work, ...files] = process.argv.slice(1);
  const runs = files.map((file) => {
    const run = JSON.parse(fs.readFileSync(file, "utf8"));
    run.summary = JSON.parse(fs.readFileSync(path.join(work, run.summary), "utf8"));
    return run;
  });
  fs.writeFileSync(path.join(work, "session.json"), JSON.stringify({ runs }, null, 2));
' "$(bench_native "$WORK")" $(for run in $runs; do bench_native "$run"; printf ' '; done) ||
  failed_run "$total" "não montei a sessão."

node "$(bench_native "$HERE/lib/verdicts.mjs")" positions-abba "$(bench_native "$WORK/session.json")" > "$WORK/verdict.json"
verdict=$?
cat "$WORK/verdict.json"

bench_say "as réplicas da api ficaram com o braço da última corrida; suba o harness de novo para voltar ao env de sempre."
exit "$verdict"
