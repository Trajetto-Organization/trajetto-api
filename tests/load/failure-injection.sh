#!/usr/bin/env bash
#
# O que o sistema faz quando uma dependência some.
#
# Não é um teste automatizado: é um roteiro executável, porque cada passo
# derruba um container de verdade e o que interessa é o COMPORTAMENTO —
# recupera sozinho? devolve 500 ou 503? o processo morre? volta ao normal
# sem reiniciar?
#
# Roda contra a API de carga (porta 3334) e o container descartável. Nunca
# contra o banco de desenvolvimento.
#
#   bash tests/load/failure-injection.sh
#
set -u

BASE="${LOAD_BASE_URL:-http://localhost:3334}"
PG="${PG_CONTAINER:-trajetto-itest-pg}"
REDIS="${REDIS_CONTAINER:-trajetto-redis}"

CONTEXT="$(cd "$(dirname "$0")" && pwd)/fixtures/load-context.json"

read_context() {
  node -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log($1)" "$CONTEXT"
}

TOKEN="$(read_context 'c.managerTokens[0]')"
BUSINESS="$(read_context 'c.businessId')"

if [ -z "$TOKEN" ]; then
  echo "Sem contexto de carga. Rode tests/load/seed.ts primeiro." >&2
  exit 1
fi

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# Status e latência de uma chamada, sem interpretar nada.
probe() {
  local label="$1" url="$2"
  local out

  out="$(curl -s -o /dev/null -w '%{http_code} %{time_total}s' \
    -H "Authorization: Bearer $TOKEN" --max-time 20 "$BASE$url" 2>&1)"

  printf '  %-22s %s\n' "$label" "$out"
}

sweep() {
  probe "health" "/health"
  probe "delivery.list" "/delivery/list-delivery?page=1&pageSize=5&businessId=$BUSINESS"
  probe "route.tower" "/route/control-tower?businessId=$BUSINESS"
  probe "catalogue (aberto)" "/integration/v1/catalogue"
}

say "== Linha de base =="
sweep

# ---------------------------------------------------------------- Redis
#
# O que Redis faz por nós: rate limit compartilhado entre réplicas e o adapter
# do socket.io. A pergunta é se a API continua ATENDENDO sem ele — a decisão
# registrada em `skipOnError: true` diz que sim, e uma decisão sem verificação
# é uma intenção.
say "== Redis derrubado =="
docker stop "$REDIS" >/dev/null
sleep 3
sweep

say "== Redis de volta =="
docker start "$REDIS" >/dev/null
sleep 6
sweep

# ------------------------------------------------------------- Postgres
#
# Aqui a expectativa é o oposto: sem banco não há resposta honesta possível
# para uma leitura. O que importa é COMO falha — 500 rápido é recuperável,
# pendurar por trinta segundos derruba o cliente junto — e se volta sozinho
# quando o banco volta, sem reiniciar o processo.
say "== Postgres derrubado =="
docker stop "$PG" >/dev/null
sleep 3
sweep

say "== Postgres de volta =="
docker start "$PG" >/dev/null
sleep 10
sweep

say "== Segunda passada, depois de tudo voltar =="
sleep 5
sweep
