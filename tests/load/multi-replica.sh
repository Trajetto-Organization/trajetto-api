#!/usr/bin/env bash
#
# Duas réplicas atrás de um balanceador, que é como isso roda em produção.
#
# O gargalo medido é a CPU de UM processo Node (~303 req/s deste mix). A
# resposta é horizontal, e "escala horizontalmente" é uma afirmação — esta é a
# verificação. Três perguntas:
#
#   1. A vazão sobe? Se duas réplicas entregam o mesmo que uma, existe um
#      recurso compartilhado saturado que ninguém tinha notado.
#   2. Os workers de fila duplicam trabalho? `FOR UPDATE SKIP LOCKED` diz que
#      não; duas réplicas disputando a mesma fila é a única prova.
#   3. O rate limit é compartilhado? Ele vive no Redis para isso. Se cada
#      réplica contar sozinha, o limite efetivo é N vezes o configurado.
#
#   bash tests/load/multi-replica.sh
#
set -u

DB="${LOAD_DATABASE_URL:-postgresql://trajetto:trajetto-password@localhost:54321/load_test?schema=public}"
PORTS="${LOAD_PORTS:-3341 3342}"

CONTEXT="$(cd "$(dirname "$0")" && pwd)/fixtures/load-context.json"

read_context() {
  node -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log($1)" "$CONTEXT"
}

TOKEN="$(read_context 'c.managerTokens[0]')"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

pids=""

cleanup() {
  for pid in $pids; do
    kill "$pid" 2>/dev/null || true
  done
}

trap cleanup EXIT

say "== Subindo as réplicas =="

for port in $PORTS; do
  NODE_ENV=test DATABASE_URL="$DB" PORT="$port" \
    npx tsx src/server.ts > "/tmp/replica-$port.log" 2>&1 &

  pids="$pids $!"

  echo "  réplica em $port (pid $!)"
done

# Espera as duas responderem antes de medir qualquer coisa.
for port in $PORTS; do
  for _ in $(seq 1 40); do
    if curl -s -o /dev/null --max-time 2 "http://localhost:$port/health"; then
      break
    fi

    sleep 1
  done

  printf '  %s: %s\n' "$port" \
    "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$port/health")"
done

say "== 1. O rate limit é compartilhado? =="
#
# 40 chamadas alternando entre as réplicas, com a MESMA sessão. O limite é de
# 300/min por usuário; o que importa aqui não é bater nele, é que as duas
# réplicas leiam o mesmo contador — o cabeçalho `x-ratelimit-remaining` tem que
# cair monotonicamente, e não reiniciar a cada troca de réplica.
first=""
last=""

for i in $(seq 1 40); do
  port=$(echo $PORTS | cut -d' ' -f$(( (i % 2) + 1 )))

  remaining="$(curl -s -o /dev/null -D - -H "Authorization: Bearer $TOKEN" \
    "http://localhost:$port/notification/unread-count" \
    | tr -d '\r' | awk 'tolower($1) == "x-ratelimit-remaining:" { print $2 }')"

  [ -z "$first" ] && first="$remaining"
  last="$remaining"
done

echo "  restante depois de 40 chamadas alternadas: $first -> $last"
echo "  (contador compartilhado cai ~40; por réplica cairia ~20 e voltaria)"

say "== 2. Os workers duplicam trabalho? =="
#
# As duas réplicas rodam os mesmos workers. Se `SKIP LOCKED` não estivesse
# segurando, a mesma linha seria reivindicada duas vezes — e `attempts` subiria
# duas vezes por ciclo em vez de uma.
docker exec trajetto-itest-pg psql -U trajetto -d load_test -tAc \
  "SELECT 'webhook_delivery em PROCESSING: ' || count(*) FROM webhook_delivery WHERE status = 'PROCESSING'"

docker exec trajetto-itest-pg psql -U trajetto -d load_test -tAc \
  "SELECT 'notification_delivery em PROCESSING: ' || count(*) FROM notification_delivery WHERE status = 'PROCESSING'"

echo "  (nenhuma linha deve ficar presa em PROCESSING com lease vencido)"

say "== 3. O socket atravessa as réplicas? =="
node "$(dirname "$0")/socket-across-replicas.mjs"

say "== 4. A fila é disputada sem duplicar? =="
node "$(dirname "$0")/queue-across-replicas.mjs"

say "== 5. A vazão sobe? =="
#
# NÃO se mede nesta máquina. Ver o README: com o nginx em container, o
# caminho vira k6 (WSL2) -> nginx (WSL2) -> host.docker.internal -> Node
# (Windows), duas travessias da fronteira WSL2/Windows por requisição — e a
# medição passa a ser da fronteira. Duas réplicas deram MENOS vazão que uma,
# com o Postgres em 0,17% de CPU.
#
# Precisa de hosts separados. Está registrado nas pendências.
echo "  (não mensurável nesta máquina — ver README e PENDENCIAS-DO-USUARIO)"

say "== Réplicas de pé; Ctrl+C para encerrar =="
wait
