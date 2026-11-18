#!/usr/bin/env bash
#
# Two (or N) replicas of the production IMAGE behind Traefik, which is how
# production runs (Dokploy + Traefik). The harness in tests/load/compose.load.yaml
# stands it up (migrating load_test first); this script only asks the
# questions. From the repository root:
#
#   docker compose --env-file .env -f tests/load/compose.load.yaml up -d --build
#   (seed, README "Como rodar")
#   bash tests/load/multi-replica.sh
#
# The measured bottleneck is the CPU of ONE Node process. The answer is
# horizontal, and "scales horizontally" is a claim — this is the check:
#
#   0. Does Traefik split the traffic between the replicas?
#   1. Is the rate limit shared? It lives in Redis for that reason.
#   2. Did any queue row get stuck with an expired lease?
#   3. Does an event emitted on one replica reach a socket on the other?
#   4. Is the queue claimed without duplicates? (proven in vitest, see below)
#   5. Does throughput go up? (k6 inside the Docker network, see below)
#
# With the roles of the same image (plano-escala LOAD-07; the harness'
# `roles` profile with LOAD_API_ROLE=api, tests/load/compose.load.yaml):
#
#   6. Does only the worker claim? The api's replicas declare no queue in
#      process_heartbeat, and no queue loop beats outside the worker.
#   7. Does a notification created on the api reach the worker in < 2 s,
#      through the wake hint over Redis (F3-04)? Fails without the hint,
#      even when the worker's 2 s sweep happens to take it in time.
#   8. Does each cron run once per scheduled minute, and only the worker
#      run the cron?
#
# Environment (optional):
#   LOAD_ENV_FILE   the env file the harness was started with (default: the
#                   repository's .env). Every compose call needs it: the
#                   compose file requires JWT_SECRET, and without it compose
#                   refuses before doing anything.
#   LOAD_STEPS      which questions to ask (default "0 1 2 3 4 5", plus
#                   "6 7 8" when the harness runs the worker)
#   LOAD_EDGE_PORT  Traefik's host port (default 8080)
#   LOAD_PORTS      the replicas' own host ports (default "3341 3342")
#
# Exits non-zero when any question fails, so it can gate something.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${LOAD_ENV_FILE:-$HERE/../../.env}"
EDGE="http://localhost:${LOAD_EDGE_PORT:-8080}"
PORTS="${LOAD_PORTS:-3341 3342}"
STEPS=" ${LOAD_STEPS:-} "

CONTEXT="$HERE/fixtures/load-context.json"
FAILURES=0

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
failed() {
  echo "  FALHOU: $*"
  FAILURES=$((FAILURES + 1))
}
asked() { case "$STEPS" in *" $1 "*) return 0 ;; esac; return 1; }

if [ ! -f "$ENV_FILE" ]; then
  echo "Arquivo de env não encontrado: $ENV_FILE" >&2
  echo "Use o mesmo do 'up' do harness (LOAD_ENV_FILE=<arquivo>); ele precisa de JWT_SECRET e JWT_SECRET_REFRESH_TOKEN." >&2
  exit 1
fi

COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$HERE/compose.load.yaml")

read_context() {
  node -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log($1)" "$CONTEXT"
}

# One value from the harness' Postgres.
psql_value() {
  "${COMPOSE[@]}" exec -T postgres psql -U trajetto -d load_test -tAc "$1"
}

# A live row of process_heartbeat (F3-03) beat in the last 90 s.
LIVE="updated_at > now() - interval '90 seconds'"

if ! curl -s -o /dev/null --max-time 3 "$EDGE/health/liveness"; then
  echo "O harness não está de pé em $EDGE. Suba com:" >&2
  echo "  docker compose --env-file .env -f tests/load/compose.load.yaml up -d --build" >&2
  exit 1
fi

# The questions of the split fleet only where there is one: without
# LOAD_STEPS, steps 6 to 8 join when the harness runs the worker.
if [ "$STEPS" = "  " ]; then
  STEPS=" 0 1 2 3 4 5 "

  if "${COMPOSE[@]}" ps --services --status running 2> /dev/null | grep -qx worker; then
    STEPS=" 0 1 2 3 4 5 6 7 8 "
  fi
fi

say "== As réplicas =="
for port in $PORTS; do
  printf '  %s: %s\n' "$port" \
    "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:$port/health/readiness")"
done

if asked 0; then
  say "== 0. O Traefik divide o tráfego? =="
  #
  # 40 calls through the edge; Traefik's access log says which replica
  # (ServiceURL) served each. One replica in the log = no balancing (wrong
  # label, a replica out of rotation by readiness). A compose command that
  # fails is reported as such — it used to read as a one-replica split.
  since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  for _ in $(seq 1 40); do
    curl -s -o /dev/null --max-time 5 "$EDGE/health/liveness"
  done
  sleep 1

  errors="$(mktemp)"
  if log="$("${COMPOSE[@]}" logs --no-log-prefix --since "$since" traefik 2> "$errors")"; then
    split="$(printf '%s\n' "$log" | node -e '
      let text = "";
      process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
        const counts = {};
        for (const line of text.split("\n")) {
          try {
            const url = JSON.parse(line).ServiceURL;
            if (url) counts[url] = (counts[url] ?? 0) + 1;
          } catch {}
        }
        for (const [url, count] of Object.entries(counts)) console.log(`  ${url}: ${count}`);
        process.exitCode = Object.keys(counts).length < 2 ? 3 : 0;
      });')"
    status=$?
    printf '%s\n' "$split"
    [ "$status" -eq 0 ] || failed "uma réplica só atendeu."
  else
    failed "o docker compose não leu o log do Traefik: $(tr '\n' ' ' < "$errors")"
  fi
  rm -f "$errors"
fi

if asked 1; then
  say "== 1. O rate limit é compartilhado? =="
  #
  # 40 calls alternating between the replicas (direct ports), with the SAME
  # session. The limit is 300/min per user; what matters is that both read
  # the same counter — `x-ratelimit-remaining` must fall by ~40, not by ~20
  # (one counter per replica, each seeing half the calls).
  TOKEN="$(read_context 'c.managerTokens[0]')"
  first=""
  last=""

  for i in $(seq 1 40); do
    port=$(echo $PORTS | cut -d' ' -f$(((i % 2) + 1)))

    remaining="$(curl -s -o /dev/null -D - -H "Authorization: Bearer $TOKEN" \
      "http://localhost:$port/notification/unread-count" \
      | tr -d '\r' | awk 'tolower($1) == "x-ratelimit-remaining:" { print $2 }')"

    [ -z "$first" ] && first="$remaining"
    last="$remaining"
  done

  echo "  restante depois de 40 chamadas alternadas: ${first:-?} -> ${last:-?}"

  if [ -z "$first" ] || [ -z "$last" ]; then
    failed "sem x-ratelimit-remaining nas respostas (token do fixture vencido? rode o seed)."
  elif [ $((first - last)) -lt 30 ]; then
    failed "o contador caiu $((first - last)), não ~40: cada réplica conta sozinha (ou a janela virou no meio; rode de novo)."
  fi
fi

if asked 2; then
  say "== 2. Alguma linha ficou presa? =="
  #
  # A PROCESSING row whose lease already expired is work no replica is doing.
  # Counting ALL the PROCESSING rows would say nothing: a replica in the
  # middle of a batch legitimately holds rows there.
  for table in webhook_delivery notification_delivery; do
    if stuck="$("${COMPOSE[@]}" exec -T postgres psql -U trajetto -d load_test -tAc \
      "SELECT count(*) FROM $table WHERE status = 'PROCESSING' AND \"leaseExpiresAt\" < now()")"; then
      echo "  $table presa (lease vencido): $stuck"
      [ "$stuck" = "0" ] || failed "$table tem $stuck linha(s) presa(s)."
    else
      failed "não foi possível consultar $table no Postgres do harness."
    fi
  done
fi

if asked 3; then
  say "== 3. O socket atravessa as réplicas? =="
  LOAD_PORTS="$PORTS" node "$HERE/socket-across-replicas.mjs" || failed "o evento não atravessou as réplicas."
fi

if asked 4; then
  say "== 4. A fila é disputada sem duplicar? =="
  #
  # Not against these replicas: they boot with production's SSRF guard,
  # which (rightly) refuses any receiver on loopback. The proof runs in
  # vitest, with the permissive verifier injected per instance and a
  # transaction holding rows like a replica in the middle of a claim:
  #
  #   yarn vitest run tests/E2E/queue-claim-concurrency.test.ts
  echo "  (ver tests/E2E/queue-claim-concurrency.test.ts)"
fi

if asked 5; then
  say "== 5. A vazão sobe? =="
  #
  # Measurable now: k6 runs on the SAME Docker network as Traefik and the
  # replicas, and no request crosses the WSL2/Windows boundary (which is what
  # the old measurement, with processes on Windows, measured). Compare the
  # same scene with one and with two replicas, on the same machine, with
  # docker stats open:
  #
  #   LOAD_REPLICAS=1 docker compose --env-file .env -f tests/load/compose.load.yaml up -d
  #   docker compose --env-file .env -f tests/load/compose.load.yaml --profile k6 run --rm k6 run /load/stress.js
  #   LOAD_REPLICAS=2 docker compose --env-file .env -f tests/load/compose.load.yaml up -d
  #   (the same scene again)
  #
  # On one machine the replicas share the cores with Postgres: the number
  # says whether the application scales up to the machine's CPU, not how
  # many hosts production needs.
  echo "  (ver o comando acima e tests/load/README.md)"
fi

if asked 6; then
  say "== 6. Só o worker reivindica? =="
  #
  # process_heartbeat says, per live process, its role, the queues it
  # claims and whether it runs the cron; worker_heartbeat has a row per
  # queue loop that beat. With LOAD_API_ROLE=api, only the worker claims,
  # and no loop beats on an api replica. Forgetting LOAD_API_ROLE leaves
  # the replicas in `all`, claiming too: this step says so.
  if fleet="$(psql_value "SELECT role || ' filas=' || coalesce(array_to_string(queues, ','), '') || ' cron=' || cron FROM process_heartbeat WHERE $LIVE ORDER BY role")" \
    && claimers="$(psql_value "SELECT coalesce(string_agg(DISTINCT role, ',' ORDER BY role), '') FROM process_heartbeat WHERE $LIVE AND cardinality(queues) > 0")" \
    && apis="$(psql_value "SELECT count(*) FROM process_heartbeat WHERE $LIVE AND role = 'api'")" \
    && strays="$(psql_value "SELECT count(*) FROM worker_heartbeat w WHERE w.\"lastBeatAt\" > now() - interval '2 minutes' AND NOT EXISTS (SELECT 1 FROM process_heartbeat p WHERE p.$LIVE AND p.role = 'worker' AND split_part(p.replica, '/', 1) = w.replica)")"; then
    printf '%s\n' "$fleet" | sed 's/^/  /'

    if [ "$claimers" != "worker" ]; then
      failed "quem consome filas: '${claimers:-ninguém}', não só o worker (suba com LOAD_API_ROLE=api e --profile roles)."
    fi

    [ "${apis:-0}" -ge 1 ] || failed "nenhum processo em PROCESS_ROLE=api vivo."
    [ "$strays" = "0" ] || failed "$strays laço(s) de fila batendo fora do worker (worker_heartbeat)."
  else
    failed "não foi possível consultar o process_heartbeat no Postgres do harness."
  fi
fi

if asked 7; then
  say "== 7. A notificação criada na api chega ao worker pela dica? =="
  #
  # The office writes to a driver through an api replica (its own port):
  # the chat's outbox event is committed there, and the api, which claims
  # no queue, publishes the hint on `<SOCKET_ADAPTER_KEY>:wake:outbox`. The
  # worker takes the event at once instead of at its next sweep. Three
  # messages, each taken in under 2 s (processedAt − created_at, both
  # from the containers' clocks on this host), and the hint seen on the
  # channel: the worker's 2 s sweep can take an event in time by luck, so
  # the time alone would pass without the hint.
  TOKEN="$(read_context 'c.managerTokens[0]')"
  DRIVER="$(read_context 'c.driverIds[0]')"
  API_PORT="${PORTS%% *}"
  hints="$(mktemp)"

  # The channel, from Redis itself, for as long as the step lasts.
  "${COMPOSE[@]}" exec -T redis timeout 40 redis-cli PSUBSCRIBE '*:wake:outbox' > "$hints" 2>&1 &
  listener=$!
  sleep 1

  for i in 1 2 3; do
    # UTC without the zone, as Prisma writes created_at.
    since="$(psql_value "SELECT (now() AT TIME ZONE 'UTC')::text")"
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -H "Idempotency-Key: multi-replica-wake-$(date +%s)-$i-$RANDOM" \
      -d "{\"driverIds\":[\"$DRIVER\"],\"kind\":\"TEXT\",\"body\":\"Despertar $i\"}" \
      "http://localhost:$API_PORT/chat/send-message")"

    if [ "$code" != "201" ]; then
      failed "o envio $i pela réplica $API_PORT respondeu $code, não 201 (token do fixture vencido? rode o seed)."
      continue
    fi

    taken=""
    for _ in $(seq 1 20); do
      taken="$(psql_value "SELECT round(extract(epoch FROM (\"processedAt\" - created_at)) * 1000)::int FROM domain_outbox_event WHERE topic = 'chat-message.sent' AND created_at >= '$since' AND \"processedAt\" IS NOT NULL ORDER BY created_at LIMIT 1")"
      [ -n "$taken" ] && break
      sleep 0.5
    done

    if [ -z "$taken" ]; then
      failed "o evento do envio $i não foi processado em 10 s (o worker está de pé?)."
    elif [ "$taken" -ge 2000 ]; then
      failed "o evento do envio $i levou ${taken} ms até o worker, não < 2000."
    else
      echo "  envio $i: ${taken} ms até o worker"
    fi
  done

  "${COMPOSE[@]}" exec -T redis sh -c 'pkill -f "redis-cli PSUBSCRIBE" || true' > /dev/null 2>&1
  wait "$listener" 2> /dev/null
  heard="$(grep -cx pmessage "$hints" || true)"
  rm -f "$hints"

  echo "  dicas de despertar no canal: ${heard}"
  [ "${heard:-0}" -ge 1 ] || failed "nenhuma dica de despertar no canal *:wake:outbox: o worker só achou o evento pela varredura."
fi

if asked 8; then
  say "== 8. Cada cron roda uma vez por minuto agendado? =="
  #
  # The election's unique (jobName, scheduledFor) keeps one run per firing
  # however many processes run the cron; with the split fleet, only the
  # worker runs it. The minute-by-minute ops-heartbeat ran exactly once in
  # each of the last three complete minutes since the first cron process
  # started, no job ran twice in a slot, and every live process with the
  # cron is a worker.
  if runs="$(psql_value "SELECT coalesce(string_agg(to_char(m.slot, 'HH24:MI') || '=' || (SELECT count(*) FROM scheduled_job_execution e WHERE e.\"jobName\" = 'ops-heartbeat' AND e.\"scheduledFor\" = m.slot), ' ' ORDER BY m.slot), '') FROM generate_series(date_trunc('minute', now()) - interval '3 minutes', date_trunc('minute', now()) - interval '1 minute', interval '1 minute') AS m(slot) WHERE m.slot > (SELECT min(started_at) FROM process_heartbeat WHERE $LIVE AND cron)")" \
    && twice="$(psql_value "SELECT count(*) FROM (SELECT 1 FROM scheduled_job_execution WHERE \"scheduledFor\" > now() - interval '15 minutes' GROUP BY \"jobName\", \"scheduledFor\" HAVING count(*) > 1) AS d")" \
    && cron="$(psql_value "SELECT coalesce(string_agg(DISTINCT role, ',' ORDER BY role), '') FROM process_heartbeat WHERE $LIVE AND cron")"; then
    echo "  ops-heartbeat por minuto: ${runs:-nenhum minuto completo ainda}"
    echo "  com o cron: ${cron:-ninguém}"

    if [ -z "$runs" ]; then
      failed "nenhum minuto completo desde que o cron subiu: rode este passo de novo daqui a 2 minutos."
    elif printf '%s\n' "$runs" | tr ' ' '\n' | grep -vq '=1$'; then
      failed "o ops-heartbeat não rodou exatamente uma vez em cada minuto: $runs."
    fi

    [ "$twice" = "0" ] || failed "$twice disparo(s) de cron com mais de uma execução."
    [ "$cron" = "worker" ] || failed "quem roda o cron: '${cron:-ninguém}', não só o worker."
  else
    failed "não foi possível consultar o scheduled_job_execution no Postgres do harness."
  fi
fi

say "== CPU e memória agora =="
if containers="$("${COMPOSE[@]}" ps -q 2> /dev/null)" && [ -n "$containers" ]; then
  # shellcheck disable=SC2086
  docker stats --no-stream --format '  {{.Name}}: CPU {{.CPUPerc}}  RAM {{.MemUsage}}' $containers
else
  echo "  (o docker compose não listou os containers do harness)"
fi

if [ "$FAILURES" -gt 0 ]; then
  say "$FAILURES verificação(ões) falhou(aram)."
  exit 1
fi
