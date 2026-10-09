#!/bin/sh
#
# Waits until a Swarm service RUNS the image a deploy shipped, and fails when
# Swarm rolled the update back instead. Runs on a Swarm manager (the Dokploy
# host), right after the Dokploy step of deploy.yml. Read-only: it only
# inspects.
#
# Why: Dokploy runs `docker stack deploy` detached (it never passes
# `--detach=false`), so its deployment is `done` as soon as the manager
# ACCEPTED the new service specs. The rollout happens afterwards, and an image
# that fails its healthcheck is rolled back by Swarm on its own
# (failure_action: rollback): the old build keeps serving under a green run.
#
# Converged means all of:
#   - the spec pins the expected digest (a rollback restores the old spec, and
#     a tag the CLI could not resolve leaves no digest at all);
#   - the update is over: UpdateStatus completed, or none (a new service, or a
#     deploy that changed nothing);
#   - every task meant to run is Running that digest, as many as the replicas
#     asked for, and no task of another image is left.
#
# Usage, on the manager:
#   verify-rollout.sh trajetto_api ghcr.io/trajetto-organization/trajetto-api@sha256:<digest>
#
# From CI, through an SSH key restricted to this script (a forced command in
# authorized_keys), the same two words arrive in SSH_ORIGINAL_COMMAND and are
# validated the same way: they are the only input a caller has.
#
# Environment (optional):
#   ROLLOUT_TIMEOUT_SECONDS  how long to wait for convergence (default 600)
#   ROLLOUT_POLL_SECONDS     interval between checks (default 5)
#
# See docs/deploy.md.
set -eu

# One line, matched whole. `printf | grep` alone would accept a value whose
# SECOND line is valid.
matches() {
  case "$1" in
    *'
'*) return 1 ;;
  esac

  printf '%s\n' "$1" | grep -Eqx "$2"
}

if [ "$#" -eq 0 ] && [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
  # Split into words without globbing; each word is validated below.
  set -f
  # shellcheck disable=SC2086
  set -- $SSH_ORIGINAL_COMMAND
  set +f
fi

if [ "$#" -ne 2 ]; then
  echo "[verify-rollout] ERRO: uso: verify-rollout.sh <serviço> ghcr.io/trajetto-organization/<imagem>@sha256:<digest>" >&2
  exit 2
fi

SERVICE="$1"
IMAGE="$2"

# <Dokploy app>_<service>, as Swarm names a stack's services.
if ! matches "$SERVICE" '[A-Za-z0-9][A-Za-z0-9_.-]{0,127}'; then
  echo "[verify-rollout] ERRO: serviço inválido: '${SERVICE}'" >&2
  exit 2
fi

# A digest, never a tag: `stable` and `staging` can move while this waits.
if ! matches "$IMAGE" 'ghcr\.io/trajetto-organization/trajetto-(api|ui|backup)@sha256:[0-9a-f]{64}'; then
  echo "[verify-rollout] ERRO: imagem inválida: '${IMAGE}'" >&2
  echo "[verify-rollout] esperado ghcr.io/trajetto-organization/<imagem>@sha256:<digest>" >&2
  exit 2
fi

DIGEST="${IMAGE#*@}"
TIMEOUT="${ROLLOUT_TIMEOUT_SECONDS:-600}"
POLL="${ROLLOUT_POLL_SECONDS:-5}"

if ! docker service inspect "$SERVICE" > /dev/null 2>&1; then
  echo "[verify-rollout] ERRO: o serviço '${SERVICE}' não existe neste manager." >&2
  echo "[verify-rollout] O nome é <app do Dokploy>_<serviço>, ex. trajetto_api." >&2
  exit 1
fi

fail() {
  echo "[verify-rollout] ERRO: $1" >&2
  echo "[verify-rollout] Detalhe: docker service ps --no-trunc ${SERVICE}" >&2
  exit 1
}

DEADLINE=$(($(date -u +%s) + TIMEOUT))
LAST=""

while :; do
  # One inspect, three fields: the image the spec pins, the update state
  # (empty when there is none) and the replicas asked for (empty in global
  # mode). A failed read is retried, not judged.
  INFO="$(docker service inspect "$SERVICE" --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}|{{if .UpdateStatus}}{{.UpdateStatus.State}}{{end}}|{{if .Spec.Mode.Replicated}}{{.Spec.Mode.Replicated.Replicas}}{{end}}' 2> /dev/null)" || INFO=""

  SPEC="${INFO%%|*}"
  REST="${INFO#*|}"
  STATE="${REST%%|*}"
  WANT="${REST#*|}"

  case "$SPEC" in
    "" | *@sha256:*) ;;
    *)
      # docker stack deploy pins the digest it resolved; without one, the
      # registry did not answer it (GHCR login on the host) and every node
      # resolves the tag by itself, whenever it pulls.
      fail "a spec de ${SERVICE} usa '${SPEC}', sem digest: o docker stack deploy não resolveu a tag no GHCR (login do registry no host)."
      ;;
  esac

  case "$STATE" in
    paused | rollback_started | rollback_paused)
      fail "o update de ${SERVICE} está '${STATE}': o Swarm reverteu ou parou o rollout de ${DIGEST}. A versão anterior continua no ar."
      ;;
    rollback_completed)
      # Also the state a deploy that changed nothing leaves behind after an
      # earlier rollback; only a spec on another digest is this rollout's.
      if [ -n "$SPEC" ] && [ "${SPEC##*@}" != "$DIGEST" ]; then
        fail "o Swarm reverteu ${SERVICE} para ${SPEC}: ${DIGEST} não passou no healthcheck ou caiu durante o monitor do update."
      fi
      ;;
  esac

  TASKS="$(docker service ps "$SERVICE" --filter desired-state=running --no-trunc --format '{{.Image}}|{{.CurrentState}}' 2> /dev/null)" || TASKS=""

  # grep -c prints 0 and exits 1 when nothing matches.
  READY="$(printf '%s\n' "$TASKS" | grep -c "@${DIGEST}|Running" || true)"
  TOTAL="$(printf '%s\n' "$TASKS" | grep -c . || true)"

  if [ -n "$SPEC" ] && [ "${SPEC##*@}" = "$DIGEST" ] \
    && { [ -z "$STATE" ] || [ "$STATE" = completed ] || [ "$STATE" = rollback_completed ]; } \
    && [ "$READY" -gt 0 ] && [ "$READY" -eq "$TOTAL" ] && [ "$READY" -ge "${WANT:-1}" ]; then
    echo "[verify-rollout] ok: ${SERVICE} roda ${DIGEST} em ${READY} réplica(s) (update: ${STATE:-nenhum})"
    exit 0
  fi

  NOW="spec=${SPEC##*@} update=${STATE:-nenhum} prontas=${READY}/${WANT:-?} tasks=${TOTAL}"

  if [ "$NOW" != "$LAST" ]; then
    echo "[verify-rollout] ${NOW}"
    LAST="$NOW"
  fi

  if [ "$(date -u +%s)" -ge "$DEADLINE" ]; then
    fail "${SERVICE} não convergiu para ${DIGEST} em ${TIMEOUT}s (${NOW})."
  fi

  sleep "$POLL"
done
