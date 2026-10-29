#!/bin/sh
#
# Waits until a Swarm service RUNS the image a deploy shipped, and fails when
# Swarm rolled the update back instead. Runs on a Swarm manager (the Dokploy
# host), right after the Dokploy step of deploy.yml. Read-only: it only
# inspects.
#
# Why: Dokploy's deployment of an Application is `done` as soon as the
# manager ACCEPTED the new service spec (it updates the Swarm service through
# the Engine API and does not wait). The rollout happens afterwards, and an
# image that fails its healthcheck is rolled back by Swarm on its own
# (failure_action: rollback in the Application's Swarm settings): the old
# build keeps serving under a green run.
#
# Two ways a spec names its image, both handled:
#   - pinned, `<repo>:<tag>@sha256:<digest>` (what the Docker CLI writes when
#     it resolves the tag): the spec itself says which build is meant;
#   - a bare tag, `<repo>:stable` (what a Dokploy Application writes: the
#     Engine API does not resolve tags, every node pulls the tag itself). The
#     spec then says nothing about the build, so each running task's container
#     is asked which digest its image was pulled as (RepoDigests). That only
#     works for tasks on THIS node: a task on another node is never counted as
#     ready, and the wait ends at the timeout saying so.
#
# Converged means all of:
#   - the spec is this repository's image, and when pinned, on the expected
#     digest (a rollback restores the old spec);
#   - the update is over: UpdateStatus completed, or none (a new service, or a
#     deploy that changed nothing);
#   - every task meant to run is Running that digest, as many as the replicas
#     asked for, and no task of another image is left.
#
# Usage, on the manager (the service is the Application's appName in Dokploy,
# the repository variable SWARM_API_SERVICE):
#   verify-rollout.sh trajetto-api-x1y2z3 ghcr.io/trajetto-organization/trajetto-api@sha256:<digest>
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

# The Application's appName, as Swarm names its service.
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

REPO="${IMAGE%@*}"
DIGEST="${IMAGE#*@}"
TIMEOUT="${ROLLOUT_TIMEOUT_SECONDS:-600}"
POLL="${ROLLOUT_POLL_SECONDS:-5}"

if ! docker service inspect "$SERVICE" > /dev/null 2>&1; then
  echo "[verify-rollout] ERRO: o serviço '${SERVICE}' não existe neste manager." >&2
  echo "[verify-rollout] O nome é o appName do Application no Dokploy (ex. trajetto-api-x1y2z3)." >&2
  exit 1
fi

fail() {
  echo "[verify-rollout] ERRO: $1" >&2
  echo "[verify-rollout] Detalhe: docker service ps --no-trunc ${SERVICE}" >&2
  exit 1
}

# The digest a task runs: from its image when pinned, else from the image
# its container was created from, as pulled on this node. `?` when this node
# cannot tell (the container is elsewhere, or not created yet).
task_digest() {
  case "$2" in
    *@sha256:*)
      echo "${2##*@}"
      return
      ;;
  esac

  container="$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' "$1" 2> /dev/null)" || container=""
  [ -n "$container" ] || {
    echo "?"
    return
  }

  image="$(docker container inspect --format '{{.Image}}' "$container" 2> /dev/null)" || image=""
  [ -n "$image" ] || {
    echo "?"
    return
  }

  pulled="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image" 2> /dev/null)" || pulled=""

  if printf '%s\n' "$pulled" | grep -Fqx "$IMAGE"; then
    echo "$DIGEST"
  else
    echo "other"
  fi
}

DEADLINE=$(($(date -u +%s) + TIMEOUT))
LAST=""

while :; do
  # One inspect, three fields: the image the spec names, the update state
  # (empty when there is none) and the replicas asked for (empty in global
  # mode). A failed read is retried, not judged.
  INFO="$(docker service inspect "$SERVICE" --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}|{{if .UpdateStatus}}{{.UpdateStatus.State}}{{end}}|{{if .Spec.Mode.Replicated}}{{.Spec.Mode.Replicated.Replicas}}{{end}}' 2> /dev/null)" || INFO=""

  SPEC="${INFO%%|*}"
  REST="${INFO#*|}"
  STATE="${REST%%|*}"
  WANT="${REST#*|}"

  # PINNED: the digest the spec pins, or empty for a bare tag.
  PINNED=""

  case "$SPEC" in
    "") ;;
    "${REPO}:"*@sha256:* | "${REPO}"@sha256:*) PINNED="${SPEC##*@}" ;;
    "${REPO}:"*) ;;
    *)
      fail "a spec de ${SERVICE} usa '${SPEC}', não ${REPO}: o serviço não é o deste deploy (confira SWARM_API_SERVICE e a imagem do Application)."
      ;;
  esac

  # Each task meant to run, as `<digest>|<current state>`.
  TASKS="$(docker service ps "$SERVICE" --filter desired-state=running --no-trunc --format '{{.ID}}|{{.Image}}|{{.CurrentState}}' 2> /dev/null)" || TASKS=""
  RUNS=""

  while IFS='|' read -r id image current; do
    [ -n "$id" ] || continue
    RUNS="${RUNS}$(task_digest "$id" "$image" < /dev/null)|${current}
"
  done << EOF
$TASKS
EOF

  # grep -c prints 0 and exits 1 when nothing matches.
  READY="$(printf '%s' "$RUNS" | grep -c "^${DIGEST}|Running" || true)"
  TOTAL="$(printf '%s' "$RUNS" | grep -c . || true)"
  UNKNOWN="$(printf '%s' "$RUNS" | grep -c '^?|' || true)"

  case "$STATE" in
    paused | rollback_started | rollback_paused)
      fail "o update de ${SERVICE} está '${STATE}': o Swarm reverteu ou parou o rollout de ${DIGEST}. A versão anterior continua no ar."
      ;;
    rollback_completed)
      # Also the state a deploy that changed nothing leaves behind after an
      # earlier rollback, so it only counts against THIS rollout when the
      # service settled on something else: a pinned spec on another digest,
      # or (bare tag) every task Running a build that is not this one.
      if [ -n "$PINNED" ] && [ "$PINNED" != "$DIGEST" ]; then
        fail "o Swarm reverteu ${SERVICE} para ${SPEC}: ${DIGEST} não passou no healthcheck ou caiu durante o monitor do update."
      fi

      if [ -n "$SPEC" ] && [ -z "$PINNED" ] && [ "$TOTAL" -gt 0 ] && [ "$READY" -eq 0 ] && [ "$UNKNOWN" -eq 0 ] \
        && [ "$(printf '%s' "$RUNS" | grep -c '|Running' || true)" -eq "$TOTAL" ]; then
        fail "o Swarm reverteu ${SERVICE}: as tasks rodam outra build, não ${DIGEST} (não passou no healthcheck ou caiu durante o monitor do update)."
      fi
      ;;
  esac

  if [ -n "$SPEC" ] && { [ -z "$PINNED" ] || [ "$PINNED" = "$DIGEST" ]; } \
    && { [ -z "$STATE" ] || [ "$STATE" = completed ] || [ "$STATE" = rollback_completed ]; } \
    && [ "$READY" -gt 0 ] && [ "$READY" -eq "$TOTAL" ] && [ "$READY" -ge "${WANT:-1}" ]; then
    echo "[verify-rollout] ok: ${SERVICE} roda ${DIGEST} em ${READY} réplica(s) (update: ${STATE:-nenhum})"
    exit 0
  fi

  NOW="spec=${PINNED:-${SPEC##*:}} update=${STATE:-nenhum} prontas=${READY}/${WANT:-?} tasks=${TOTAL}"

  if [ "$UNKNOWN" -gt 0 ]; then
    NOW="${NOW} sem-digest-neste-nó=${UNKNOWN}"
  fi

  if [ "$NOW" != "$LAST" ]; then
    echo "[verify-rollout] ${NOW}"
    LAST="$NOW"
  fi

  if [ "$(date -u +%s)" -ge "$DEADLINE" ]; then
    if [ "$UNKNOWN" -gt 0 ]; then
      fail "${SERVICE} não convergiu para ${DIGEST} em ${TIMEOUT}s (${NOW}): ${UNKNOWN} task(s) sem container legível neste nó (outro nó do Swarm, ou ainda não criado)."
    fi

    fail "${SERVICE} não convergiu para ${DIGEST} em ${TIMEOUT}s (${NOW})."
  fi

  sleep "$POLL"
done
