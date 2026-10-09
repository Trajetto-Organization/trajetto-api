#!/bin/sh
#
# Runs the release step — `prisma migrate deploy` plus the idempotent seeds —
# ONCE, as a one-off Swarm job, with the exact image about to be rolled out,
# BEFORE the rollout. Runs on a Swarm manager.
#
# Why: migrating at the boot of every replica turned one bad migration into a
# cluster-wide problem. A migration that failed, or that outlived the liveness
# budget and was killed, left `finished_at` NULL in `_prisma_migrations`; from
# then on every `migrate deploy` of every image version — the running one
# included — refused to start (P3009), so the next restart of any replica was
# an outage until someone resolved it by hand. As one job, a failing migration
# fails one step of the promote workflow: `stable` does not move, Dokploy is
# not asked to deploy, and the running replicas never notice.
#
# Usage, on the manager:
#   run-release-migrations.sh ghcr.io/trajetto-organization/trajetto-api:sha-<sha>
#
# `sha-<sha>` is the immutable tag every push to staging publishes. The older
# `main-<sha>` builds (published before the staging branch existed) are still
# accepted, so a rollback to one of them can migrate too.
#
# From CI, through an SSH key restricted to this script (a forced command in
# authorized_keys), the image arrives in SSH_ORIGINAL_COMMAND instead — and is
# validated exactly the same way, because it is the only input a caller has.
#
# Environment (all optional):
#   STACK_NAME               the Swarm stack: the Dokploy app name of the API
#                            compose (default trajetto)
#   API_SERVICE              service whose env the job reuses (default <stack>_api)
#   MIGRATE_NETWORK          network to join (default <stack>_backend, the
#                            stack's internal network, where the database is)
#   MIGRATE_TIMEOUT_SECONDS  how long to wait for the job (default 900)
#
# See docs/deploy.md ("Migrations"), including what to do with a P3009.
set -eu

IMAGE="${1:-${SSH_ORIGINAL_COMMAND:-}}"

# Only an immutable build of this API. `latest`/`stable` move under our feet,
# and anything else in this string would end up on a docker command line.
# One line only: grep matches line by line, so a value whose FIRST line was
# valid passed whole, newline and all.
case "$IMAGE" in
  *'
'*) IMAGE_LINES=many ;;
  *) IMAGE_LINES=one ;;
esac

if [ "$IMAGE_LINES" != one ] \
  || ! printf '%s\n' "$IMAGE" | grep -Eqx 'ghcr\.io/trajetto-organization/trajetto-api:(sha|main)-[0-9a-f]{7,40}'; then
  echo "[release-migrations] ERRO: imagem inválida: '${IMAGE}'" >&2
  echo "[release-migrations] esperado ghcr.io/trajetto-organization/trajetto-api:sha-<sha> (ou main-<sha>, builds antigos)" >&2
  exit 2
fi

STACK="${STACK_NAME:-trajetto}"
API_SERVICE="${API_SERVICE:-${STACK}_api}"
TIMEOUT="${MIGRATE_TIMEOUT_SECONDS:-900}"
POLL="${MIGRATE_POLL_SECONDS:-5}"

# The stack's internal network: the database is on it and on nothing else.
# Missing means STACK_NAME is not the stack running here — under Dokploy the
# stack is named after the app, not after this repository.
MIGRATE_NETWORK="${MIGRATE_NETWORK:-${STACK}_backend}"

if ! docker network inspect "$MIGRATE_NETWORK" > /dev/null 2>&1; then
  echo "[release-migrations] ERRO: a rede '${MIGRATE_NETWORK}' não existe neste nó." >&2
  echo "[release-migrations] Confira STACK_NAME (o nome do app no Dokploy) ou defina MIGRATE_NETWORK." >&2
  exit 1
fi

if ! docker service inspect "$API_SERVICE" > /dev/null 2>&1; then
  echo "[release-migrations] ERRO: o serviço '${API_SERVICE}' não existe." >&2
  echo "[release-migrations] Confira STACK_NAME (o nome do app no Dokploy) ou defina API_SERVICE." >&2
  exit 1
fi

JOB="trajetto-migrate-$(date -u +%Y%m%d%H%M%S)"

# The job reuses the running API's environment: the database credentials never
# have to live in CI. Written 0600, deleted as soon as the job exists.
ENV_FILE="$(mktemp)"
chmod 600 "$ENV_FILE"

# none -> running -> finished. The job is removed on exit only once it has
# FINISHED: removing the service kills a container that is still migrating —
# the interrupted run that leaves P3009 behind. So a wait that ends early (the
# timeout below, a Ctrl-C on the manager, a cancelled run, a dropped SSH
# session) ends the wait, never the migration.
JOB_STATE=none

cleanup() {
  rm -f "$ENV_FILE"

  case "$JOB_STATE" in
    finished) docker service rm "$JOB" > /dev/null 2>&1 || true ;;
    running)
      echo "[release-migrations] ${JOB} segue rodando e não foi removido; nada foi promovido." >&2
      echo "[release-migrations] Acompanhe com 'docker service logs -f ${JOB}' e remova com 'docker service rm ${JOB}' quando terminar. Ver docs/deploy.md (Migrations)." >&2
      ;;
  esac
}

trap cleanup EXIT
# Trapped so that the EXIT trap runs on every shell (dash skips it on a
# signal it does not trap); HUP is the SSH session going away.
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

docker service inspect \
  --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' \
  "$API_SERVICE" > "$ENV_FILE"

if ! grep -q '^DATABASE_URL=' "$ENV_FILE"; then
  echo "[release-migrations] ERRO: ${API_SERVICE} não tem DATABASE_URL no env" >&2
  exit 1
fi

echo "[release-migrations] ${IMAGE} como job ${JOB} na rede ${MIGRATE_NETWORK}"

# --mode replicated-job + --restart-condition none: runs once, never retried
#   behind our back — a second attempt over a half-applied migration is how
#   P3009 gets worse.
# --no-healthcheck: the image's HEALTHCHECK probes :3333, which the release
#   step never opens; with it Swarm would kill the job mid-migration.
docker service create \
  --detach \
  --name "$JOB" \
  --mode replicated-job \
  --restart-condition none \
  --no-healthcheck \
  --with-registry-auth \
  --network "$MIGRATE_NETWORK" \
  --env-file "$ENV_FILE" \
  "$IMAGE" ./docker-entrypoint.sh migrate > /dev/null

JOB_STATE=running

# The CLI has copied it into the job's spec: the file goes now rather than at
# exit, which a SIGKILL or a shell that dies on a broken pipe never reaches.
rm -f "$ENV_FILE"

DEADLINE=$(($(date -u +%s) + TIMEOUT))
STATE=""

while :; do
  STATE="$(docker service ps "$JOB" --no-trunc --format '{{.CurrentState}}' | head -n 1)"

  case "$STATE" in
    Complete* | Failed* | Rejected* | Shutdown* | Orphaned*)
      JOB_STATE=finished
      break
      ;;
  esac

  if [ "$(date -u +%s)" -ge "$DEADLINE" ]; then
    break
  fi

  sleep "$POLL"
done

docker service logs --raw "$JOB" 2>&1 || true

case "$STATE" in
  Complete*)
    echo "[release-migrations] ok: migrations e seeds aplicados"
    exit 0
    ;;
  Failed* | Rejected* | Shutdown* | Orphaned*)
    echo "[release-migrations] ERRO: o job terminou em '${STATE}'. Nada foi promovido." >&2
    echo "[release-migrations] Se a saída acima fala em P3009 ou numa migration pela metade, siga docs/deploy.md (Migrations)." >&2
    exit 1
    ;;
  *)
    # Still running: left to finish (see JOB_STATE above), and a human
    # decides. The exit trap says how to follow it.
    echo "[release-migrations] ERRO: ${JOB} passou de ${TIMEOUT}s (estado '${STATE}')." >&2
    exit 1
    ;;
esac
