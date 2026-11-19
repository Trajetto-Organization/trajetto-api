#!/usr/bin/env bash
#
# The routing of the roles by Path, proved through Traefik's access log
# (plano-escala F5-26; docs/runbooks/roteamento-por-path.md).
#
# On staging and production the realtime and the ingest are Applications
# of their own, reached on the API's host by a Domain with a Path
# (/socket.io, /route/positions). Dokploy writes each Domain as a file
# router with no priority, and Traefik orders the routers by the length of
# their rule: the longer Path must win over the API's bare host, a sibling
# path (/route/live) must stay on the API, and a Path whose Application has
# no task answers 502, never the API's answer. The harness's Traefik loads
# the same shape (tests/load/traefik/dokploy-roles.yml, host
# roles.load.localhost); this asks, and reads which router served each:
#
#   1. GET  /health/liveness       → trajetto-api-router-1
#   2. GET  /socket.io/ (polling)  → trajetto-realtime-router-1
#   3. POST /route/positions       → trajetto-ingest-router-1
#   4. GET  /route/live            → trajetto-api-router-1 (not the ingest's)
#   5. the ingest at 0 replicas: POST /route/positions → 502 from its router,
#      and back at 1, served again
#
# A status of 404 or 502 is a failure in steps 1 to 4 (no router, or a dead
# backend); 401 or 400 is the application answering, which is what counts.
#
# From the repository root, with the harness up with the three profiles:
#
#   LOAD_API_ROLE=api LOAD_API_SOCKETS=false docker compose --env-file .env \
#     -f tests/load/compose.load.yaml --profile roles --profile realtime \
#     --profile ingest up -d --build
#   bash tests/load/roles-routing.sh
#
# Environment (optional):
#   LOAD_ENV_FILE        the env file the harness was started with (default:
#                        the repository's .env)
#   LOAD_EDGE_PORT       Traefik's host port (default 8080)
#   ROUTING_HOST         the host of the file routers (roles.load.localhost)
#   ROUTING_TRAEFIK_CONTAINER, ROUTING_INGEST_CONTAINER
#                        a stack outside compose (a bench of stand-ins):
#                        the access log from `docker logs` of the first,
#                        and step 5 by `docker stop`/`docker start` of the
#                        second, instead of compose's logs and --scale
#   ROUTING_WAIT_SECONDS how long step 5 waits for each state (default 60)
#
# Exits non-zero when any step fails.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${LOAD_ENV_FILE:-$HERE/../../.env}"
EDGE="http://localhost:${LOAD_EDGE_PORT:-8080}"
HOST="${ROUTING_HOST:-roles.load.localhost}"
WAIT_SECONDS="${ROUTING_WAIT_SECONDS:-60}"
TRAEFIK_CONTAINER="${ROUTING_TRAEFIK_CONTAINER:-}"
INGEST_CONTAINER="${ROUTING_INGEST_CONTAINER:-}"

FAILURES=0
PROBES="$(mktemp)"
trap 'rm -f "$PROBES"' EXIT

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
failed() {
  echo "  FALHOU: $*"
  FAILURES=$((FAILURES + 1))
}

if [ -z "$TRAEFIK_CONTAINER" ]; then
  if [ ! -f "$ENV_FILE" ]; then
    echo "Arquivo de env não encontrado: $ENV_FILE" >&2
    echo "Use o mesmo do 'up' do harness (LOAD_ENV_FILE=<arquivo>)." >&2
    exit 1
  fi

  COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$HERE/compose.load.yaml")
fi

traefik_log() {
  if [ -n "$TRAEFIK_CONTAINER" ]; then
    docker logs --since "$1" "$TRAEFIK_CONTAINER" 2>&1
  else
    "${COMPOSE[@]}" logs --no-log-prefix --since "$1" traefik
  fi
}

ingest_to() {
  if [ -n "$INGEST_CONTAINER" ]; then
    if [ "$1" = 0 ]; then
      docker stop "$INGEST_CONTAINER" > /dev/null
    else
      docker start "$INGEST_CONTAINER" > /dev/null
    fi
  else
    "${COMPOSE[@]}" --profile ingest up -d --no-deps --scale "ingest=$1" ingest
  fi
}

# One request through the edge with the file routers' host, tagged so its
# line in the access log is found again. Prints the status.
request() {
  local method=$1 path=$2 tag=$3 joiner="?"

  case "$path" in *\?*) joiner="&" ;; esac

  curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X "$method" \
    -H "Host: $HOST" -H "content-type: application/json" \
    ${4:+--data "$4"} "${EDGE}${path}${joiner}rr=${tag}"
}

# The router and the status the access log recorded for a tag.
served_by() {
  printf '%s\n' "$1" | node -e '
    const tag = process.argv[1];
    let text = "";
    process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
      for (const line of text.split("\n")) {
        try {
          const entry = JSON.parse(line);
          if (String(entry.RequestPath ?? "").includes(`rr=${tag}`)) {
            console.log(`${entry.RouterName ?? "-"} ${entry.DownstreamStatus ?? "-"}`);
            return;
          }
        } catch {}
      }
      console.log("- -");
    });' "$2"
}

# Asks, then remembers what it expects: `<tag> <router> <wanted status>`.
probe() {
  local name=$1 method=$2 path=$3 router=$4 wanted=$5 body=${6:-}
  local tag status

  tag="$(date +%s)-$RANDOM-$RANDOM"
  status=$(request "$method" "$path" "$tag" "$body")

  printf '  %-34s %s %s → HTTP %s\n' "$name" "$method" "$path" "$status"
  printf '%s %s %s %s\n' "$tag" "$router" "$wanted" "$name" >> "$PROBES"
}

# Every probe against the access log since `since`.
judge() {
  local since=$1 log tag router wanted name got_router got_status

  sleep 1

  if ! log="$(traefik_log "$since")"; then
    failed "o log do Traefik não foi lido"
    return
  fi

  while read -r tag router wanted name; do
    read -r got_router got_status <<< "$(served_by "$log" "$tag")"

    if [ "${got_router%@*}" != "$router" ]; then
      failed "${name}: atendido por '${got_router}', esperado ${router}"
    elif [ "$wanted" = "app" ]; then
      case "$got_status" in
        404 | 502 | 503 | 504 | -) failed "${name}: HTTP ${got_status} pelo ${router} (sem backend ou sem rota)" ;;
        *) echo "  ok: ${name} pelo ${router} (HTTP ${got_status})" ;;
      esac
    elif [ "$got_status" != "$wanted" ]; then
      failed "${name}: HTTP ${got_status} pelo ${router}, esperado ${wanted}"
    else
      echo "  ok: ${name} pelo ${router} (HTTP ${got_status})"
    fi
  done < "$PROBES"

  : > "$PROBES"
}

# Until POST /route/positions answers as wanted (502 or the application).
wait_ingest() {
  local wanted=$1 deadline=$((SECONDS + WAIT_SECONDS)) status

  while [ "$SECONDS" -lt "$deadline" ]; do
    status=$(request POST /route/positions "wait-$RANDOM" '{"positions":[]}')

    if [ "$wanted" = 502 ] && [ "$status" = 502 ]; then return 0; fi
    if [ "$wanted" = app ] && [ "$status" != 502 ] && [ "$status" != 000 ]; then return 0; fi

    sleep 1
  done

  return 1
}

say "== 1 a 4. Cada Path no seu papel (host ${HOST}) =="
since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
probe "1. a API pelo host" GET /health/liveness trajetto-api-router-1 app
probe "2. o realtime em /socket.io" GET "/socket.io/?EIO=4&transport=polling" trajetto-realtime-router-1 app
probe "3. o ingest em /route/positions" POST /route/positions trajetto-ingest-router-1 app '{"positions":[]}'
probe "4. /route/live fica na API" GET /route/live trajetto-api-router-1 app
judge "$since"

say "== 5. O ingest com 0 réplicas dá 502, e volta =="
if ingest_to 0 && wait_ingest 502; then
  since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  probe "5a. /route/positions sem ingest" POST /route/positions trajetto-ingest-router-1 502 '{"positions":[]}'
  judge "$since"
else
  failed "5a. o ingest em 0 réplicas não deu 502 em ${WAIT_SECONDS}s"
fi

if ingest_to 1 && wait_ingest app; then
  since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  probe "5b. /route/positions com o ingest de volta" POST /route/positions trajetto-ingest-router-1 app '{"positions":[]}'
  judge "$since"
else
  failed "5b. o ingest não voltou a atender em ${WAIT_SECONDS}s"
fi

if [ "$FAILURES" -gt 0 ]; then
  say "roles-routing: ${FAILURES} falha(s)"
  exit 1
fi

say "roles-routing: ok"
