#!/usr/bin/env bash
#
# Points the PgBouncer at another primary (plano-escala F4-44): the
# failover's one change on the runtime's side. Every Application reaches
# Postgres through trajetto-pgbouncer, so after a promote nothing else
# changes but PGBOUNCER_PRIMARY_HOST in its Environment and a Deploy of it
# (docs/runbooks/failover-standby.md). The direct URLs (the batch's and the
# trajetto-api-migrate's) the runbook changes by hand.
#
# Usage, by the owner, on the Dokploy host (the panel answers on
# localhost there) or anywhere that reaches the panel and, for the wait,
# runs the Swarm's docker CLI:
#
#   DOKPLOY_API_KEY=<key> infra/pgbouncer/retarget.sh \
#     <applicationId of trajetto-pgbouncer> <App Name of the new primary> \
#     [--expect-current <App Name of the old primary>] [--dry-run | --wait-only]
#
#   DOKPLOY_URL               the panel (default http://localhost:3000)
#   DOKPLOY_API_KEY           the owner's key (Dokploy → Settings → Profile →
#                             API/CLI); read from a file by curl, never on a
#                             command line, never printed
#   RETARGET_TIMEOUT_SECONDS  how long to wait for the new task (default 300)
#
# In order:
#   1. application.one: refuses an Application that is not a
#      trajetto-pgbouncer (its Docker image), so a wrong id never gets a new
#      Environment, and one whose Environment has no PGBOUNCER_PRIMARY_HOST
#      line, or more than one;
#   2. with --expect-current, refuses when the line names another host (a
#      second run after the first went through, the other environment's id);
#      already on the new host, it only waits and checks;
#   3. application.saveEnvironment with that one line changed and every
#      other byte as it was (the panel's Environment → Save);
#   4. application.deploy (the panel's Deploy): start-first, the old task
#      drains its clients inside its 90 s grace;
#   5. on this manager, waits for the service's spec to carry the new host
#      and for a healthy task running it, then asks that task (inside the
#      container, as pgbouncer_stats: SHOW DATABASES) where it points.
# Each step prints the seconds since the start: the drill's RTO counts them.
#
# --dry-run stops after 2 and says what it would change; --wait-only skips
# 3 and 4 (the Environment changed by hand in the panel, the Dokploy API
# refused) and only waits and checks.
#
# Exit: 0 pointed (or already); 2 usage; 3 refused (not the PgBouncer, no
# line or two, another current host); 4 Dokploy refused or failed; 5 the
# new task did not come up in time.
set -Eeuo pipefail

say() { printf 'retarget: %s\n' "$*" >&2; }
step() { printf 'retarget: [%3ss] %s\n' "$((SECONDS - started))" "$*" >&2; }
die() {
  local code=$1
  shift
  printf 'retarget: ERRO: %s\n' "$*" >&2
  exit "$code"
}

started=$SECONDS
URL=${DOKPLOY_URL:-http://localhost:3000}
URL=${URL%/}
TIMEOUT=${RETARGET_TIMEOUT_SECONDS:-300}
PYTHON=${RETARGET_PYTHON:-python3}

usage() {
  die 2 "uso: retarget.sh <applicationId> <host novo> [--expect-current <host>] [--dry-run | --wait-only]"
}

[ "$#" -ge 2 ] || usage
APPLICATION_ID=$1
NEW_HOST=$2
shift 2
EXPECT=""
MODE=apply
while [ "$#" -gt 0 ]; do
  case $1 in
    --expect-current)
      [ "$#" -ge 2 ] || usage
      EXPECT=$2
      shift 2
      ;;
    --dry-run) MODE=dry-run && shift ;;
    --wait-only) MODE=wait-only && shift ;;
    *) usage ;;
  esac
done

# A Dokploy id, and a host the image's entrypoint would take: never a list,
# never options (PGBOUNCER_PRIMARY_HOST goes into pgbouncer.ini as is).
HOST_RE='^[A-Za-z0-9]([A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$'
[[ $APPLICATION_ID =~ ^[A-Za-z0-9_-]{6,64}$ ]] || die 2 "applicationId inválido: '${APPLICATION_ID}'"
[[ $NEW_HOST =~ $HOST_RE ]] || die 2 "host novo inválido: '${NEW_HOST}'"
[ -z "$EXPECT" ] || [[ $EXPECT =~ $HOST_RE ]] || die 2 "--expect-current inválido: '${EXPECT}'"
[[ $TIMEOUT =~ ^[0-9]{1,4}$ ]] && [ "$TIMEOUT" -ge 10 ] || die 2 "RETARGET_TIMEOUT_SECONDS inválido: '${TIMEOUT}'"
[[ $URL =~ ^https?://[A-Za-z0-9.:-]+$ ]] || die 2 "DOKPLOY_URL inválido: só o esquema, o host e a porta"
[ -n "${DOKPLOY_API_KEY:-}" ] || die 2 "DOKPLOY_API_KEY ausente (Dokploy → Settings → Profile → API/CLI)"
command -v curl > /dev/null || die 2 "curl não encontrado"
command -v "$PYTHON" > /dev/null || die 2 "${PYTHON} não encontrado (o Ubuntu do host traz o python3)"
command -v docker > /dev/null || die 2 "docker não encontrado: rode no manager do Swarm"

# The key and every answer with the Environment stay in files only this
# user reads, removed at the end.
WORK=$(mktemp -d)
chmod 0700 "$WORK"
trap 'rm -rf "$WORK"' EXIT
(umask 077 && printf 'x-api-key: %s\n' "$DOKPLOY_API_KEY" > "$WORK/headers")
unset DOKPLOY_API_KEY

# api METHOD PATH [BODY_FILE]: the answer in $WORK/answer; fails with exit 4.
api() {
  local method=$1 path=$2 body=${3:-} status
  local args=(-sS -o "$WORK/answer" -w '%{http_code}' -H @"$WORK/headers" -H 'accept: application/json' --max-time 60)
  if [ -n "$body" ]; then
    args+=(-X "$method" -H 'content-type: application/json' --data-binary @"$body")
  fi
  status=$(curl "${args[@]}" "${URL}${path}") || die 4 "o Dokploy não respondeu a ${path%%\?*}"
  if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
    # The answer may echo the request: never printed.
    die 4 "o Dokploy recusou ${path%%\?*} (HTTP ${status}); faça a troca à mão no painel e rode de novo com --wait-only"
  fi
}

# JSON, by Python's own parser (the host has no jq); prints names and hosts
# only, never the Environment's other lines.
read_application() {
  "$PYTHON" - "$WORK/answer" "$WORK/plan" << 'PY'
import json, sys
app = json.load(open(sys.argv[1], encoding="utf-8"))
env = app.get("env") or ""
lines = env.split("\n")
found = [i for i, line in enumerate(lines) if line.rstrip("\r").startswith("PGBOUNCER_PRIMARY_HOST=")]
current = lines[found[0]].rstrip("\r").split("=", 1)[1] if len(found) == 1 else ""
with open(sys.argv[2], "w", encoding="utf-8", newline="\n") as plan:
    plan.write("\n".join([
        str(app.get("appName") or ""),
        str(app.get("sourceType") or ""),
        str(app.get("dockerImage") or ""),
        str(len(found)),
        current,
    ]) + "\n")
PY
}

write_body() {
  "$PYTHON" - "$WORK/answer" "$WORK/body.json" "$APPLICATION_ID" "$NEW_HOST" << 'PY'
import json, sys
app = json.load(open(sys.argv[1], encoding="utf-8"))
lines = (app.get("env") or "").split("\n")
for i, line in enumerate(lines):
    if line.rstrip("\r").startswith("PGBOUNCER_PRIMARY_HOST="):
        ending = "\r" if line.endswith("\r") else ""
        lines[i] = "PGBOUNCER_PRIMARY_HOST=" + sys.argv[4] + ending
body = {
    "applicationId": sys.argv[3],
    "env": "\n".join(lines),
    "buildArgs": app.get("buildArgs"),
    "buildSecrets": app.get("buildSecrets"),
}
with open(sys.argv[2], "w", encoding="utf-8") as out:
    json.dump(body, out)
PY
}

# --- 1 and 2: the Application, and where it points now ------------------------

api GET "/api/application.one?applicationId=${APPLICATION_ID}"
read_application
{
  read -r APP_NAME
  read -r SOURCE
  read -r IMAGE
  read -r LINES
  read -r CURRENT
} < "$WORK/plan"

[[ $APP_NAME =~ ^[A-Za-z0-9._-]+$ ]] || die 3 "a Application não tem App Name"
if [ "$SOURCE" != docker ] || ! [[ $IMAGE =~ /trajetto-pgbouncer(:|@|$) ]]; then
  die 3 "a Application ${APP_NAME} não é a trajetto-pgbouncer (imagem '${IMAGE}'): confira o applicationId"
fi
[ "$LINES" = 1 ] || die 3 "o Environment de ${APP_NAME} tem ${LINES} linhas PGBOUNCER_PRIMARY_HOST, esperado 1"
step "${APP_NAME} aponta para ${CURRENT}"

if [ "$CURRENT" = "$NEW_HOST" ]; then
  say "já aponta para ${NEW_HOST}: nada a trocar, só a conferência"
  [ "$MODE" != dry-run ] || exit 0
  MODE=wait-only
elif [ -n "$EXPECT" ] && [ "$CURRENT" != "$EXPECT" ]; then
  die 3 "${APP_NAME} aponta para ${CURRENT}, não para ${EXPECT} (--expect-current): nada foi mudado"
fi

if [ "$MODE" = dry-run ]; then
  say "--dry-run: trocaria PGBOUNCER_PRIMARY_HOST de ${CURRENT} para ${NEW_HOST} e faria o Deploy de ${APP_NAME}"
  exit 0
fi

# --- 3 and 4: the Environment, then the Deploy -----------------------------------

if [ "$MODE" = apply ]; then
  write_body
  chmod 0600 "$WORK/body.json"
  api POST /api/application.saveEnvironment "$WORK/body.json"
  rm -f "$WORK/body.json"
  step "Environment salvo: PGBOUNCER_PRIMARY_HOST=${NEW_HOST}"
  printf '{"applicationId":"%s"}' "$APPLICATION_ID" > "$WORK/deploy.json"
  api POST /api/application.deploy "$WORK/deploy.json"
  step "Deploy de ${APP_NAME} pedido (start-first: a tarefa antiga drena os clientes)"
fi

# --- 5: the new task, and where it points ---------------------------------------

spec_points() {
  docker service inspect -f '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' "$APP_NAME" 2> /dev/null |
    grep -qx "PGBOUNCER_PRIMARY_HOST=${NEW_HOST}"
}

# A healthy task of the service on this node running the new host: its id.
new_task() {
  local id
  for id in $(docker ps -q --filter "label=com.docker.swarm.service.name=${APP_NAME}" --filter health=healthy 2> /dev/null); do
    if docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$id" 2> /dev/null |
      grep -qx "PGBOUNCER_PRIMARY_HOST=${NEW_HOST}"; then
      printf '%s' "$id"
      return 0
    fi
  done
  return 1
}

deadline=$((SECONDS + TIMEOUT))
until spec_points; do
  [ "$SECONDS" -lt "$deadline" ] || die 5 "o serviço ${APP_NAME} não recebeu o host novo em ${TIMEOUT} s: confira o Deploy no painel"
  sleep 2
done
step "o serviço ${APP_NAME} já leva o host novo"

task=""
until task=$(new_task); do
  [ "$SECONDS" -lt "$deadline" ] || die 5 "nenhuma tarefa saudável de ${APP_NAME} com o host novo em ${TIMEOUT} s: docker service ps ${APP_NAME}"
  sleep 2
done

# Asked inside the container, as the stats login, over its loopback.
databases=$(docker exec "$task" sh -c 'PGPASSWORD="$PGBOUNCER_STATS_PASSWORD" psql -X -At -h 127.0.0.1 -p 6432 -U pgbouncer_stats -d pgbouncer -c "SHOW DATABASES"' 2> /dev/null) ||
  die 5 "a tarefa nova de ${APP_NAME} não respondeu ao SHOW DATABASES"
pointed=$(printf '%s\n' "$databases" | awk -F'|' -v host="$NEW_HOST" '$1 != "pgbouncer" && $2 == host { n++ } END { print n + 0 }')
others=$(printf '%s\n' "$databases" | awk -F'|' -v host="$NEW_HOST" '$1 != "pgbouncer" && $2 != host { n++ } END { print n + 0 }')
[ "$pointed" -ge 1 ] && [ "$others" = 0 ] ||
  die 5 "a tarefa nova de ${APP_NAME} não aponta só para ${NEW_HOST} (SHOW DATABASES)"
step "${APP_NAME} aponta para ${NEW_HOST}: a tarefa nova está saudável e o SHOW DATABASES confirma"
