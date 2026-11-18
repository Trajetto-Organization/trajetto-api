#!/usr/bin/env bash
#
# The deploy of the Applications that run the API's image in another role
# (plano-escala F3-31a): worker, scheduler, worker-external, ingest and
# realtime, called by the deploy action (.github/actions/deploy) around the
# API's own deploy.
#
#   deploy-roles.sh before-api   worker → scheduler → worker-external
#   deploy-roles.sh after-api    ingest → realtime
#   deploy-roles.sh follow       once everything is green: the roles not
#                                deployed (no Application id) get their tag
#                                on the API's digest
#   deploy-roles.sh restore      after a failure: the tag of the role whose
#                                Dokploy deploy failed goes back to what it
#                                named before (only with RESTORE_TAGS=true,
#                                staging)
#
# Each role's Application pulls `trajetto-api:<tag>-<role>`, never the API's
# `<tag>`. One tag for all would let the Swarm pull the new build out of
# order on any task restart — a worker restarting before the migrations, an
# ingest before the API. Each role's tag moves to the API's digest right
# before its own deploy, as the API's and the AI's do.
#
# A role without its Application id (DOKPLOY_<ROLE>_APPLICATION_ID) is not
# deployed: a notice, and its tag follows the API's digest at the end, once
# the run is green, so an Application created later starts on the build the
# environment runs. Without any new secret the run deploys exactly what it
# deployed before. A role's failed deploy fails the step: nothing after it
# is deployed, the API included.
#
# The state of each role is written to STATE_FILE, one `<role> <status>
# <previous digest or ->` per line (status: deployed, failed, absent), for
# the `follow` and `restore` phases of the same run. Without STATE_FILE,
# nothing was recorded and both phases find nothing to do.
#
# Environment: TAG, API_DIGEST, STATE_FILE, RESTORE_TAGS, DOKPLOY_ENABLED
# (`true` when the environment has Dokploy), DOKPLOY_URL, DOKPLOY_API_KEY,
# DOKPLOY_WORKER_APPLICATION_ID, DOKPLOY_SCHEDULER_APPLICATION_ID,
# DOKPLOY_WORKER_EXTERNAL_APPLICATION_ID, DOKPLOY_INGEST_APPLICATION_ID and
# DOKPLOY_REALTIME_APPLICATION_ID. DEPLOY_SCRIPT is dokploy-deploy.mjs.
set -euo pipefail

REPO=ghcr.io/trajetto-organization/trajetto-api
DEPLOY_SCRIPT=${DEPLOY_SCRIPT:-.github/scripts/dokploy-deploy.mjs}
STATE_FILE=${STATE_FILE:-}

BEFORE_API=(worker scheduler worker-external)
AFTER_API=(ingest realtime)
ROLES=("${BEFORE_API[@]}" "${AFTER_API[@]}")

usage() {
  echo "uso: deploy-roles.sh before-api | after-api | follow | restore" >&2
  exit 2
}

summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '%s\n' "$1" >> "$GITHUB_STEP_SUMMARY"
  fi
}

# DOKPLOY_WORKER_EXTERNAL_APPLICATION_ID for worker-external.
id_of() {
  local name
  name="DOKPLOY_$(printf '%s' "$1" | tr '[:lower:]-' '[:upper:]_')_APPLICATION_ID"
  printf '%s' "${!name:-}"
}

record() {
  if [ -n "$STATE_FILE" ]; then
    printf '%s %s %s\n' "$1" "$2" "${3:--}" >> "$STATE_FILE"
  fi
}

# The last status recorded for a role in this run, or nothing.
status_of() {
  if [ -n "$STATE_FILE" ] && [ -f "$STATE_FILE" ]; then
    awk -v role="$1" '$1 == role { status = $2 } END { print status }' "$STATE_FILE"
  fi
}

deploy_phase() {
  local role id previous absent=""

  if [ -z "${API_DIGEST:-}" ] || [ -z "${TAG:-}" ]; then
    echo "::error::deploy-roles.sh precisa de TAG e API_DIGEST." >&2
    exit 1
  fi

  for role in "$@"; do
    id=$(id_of "$role")

    if [ "${DOKPLOY_ENABLED:-false}" != "true" ] || [ -z "$id" ]; then
      record "$role" absent
      absent="$absent trajetto-$role"
      continue
    fi

    # What the role's tag names before it moves: a failed deploy on
    # staging puts it back. GHCR not answering fails here, before the move.
    previous=$(bash .github/scripts/ghcr.sh digest "${REPO}:${TAG}-${role}")

    bash .github/scripts/ghcr.sh tag "${REPO}:${TAG}-${role}" "${REPO}@${API_DIGEST}"
    summary "trajetto-api:${TAG}-${role} → ${API_DIGEST}"

    if DOKPLOY_APPLICATION_ID="$id" DOKPLOY_APP_LABEL="trajetto-${role}" \
      node "$DEPLOY_SCRIPT"; then
      record "$role" deployed "$previous"
    else
      record "$role" failed "$previous"
      echo "::error::O deploy de trajetto-${role} falhou: nada depois dele foi implantado (a API inclusive), e o ambiente segue no build anterior."
      exit 1
    fi
  done

  if [ -n "$absent" ]; then
    echo "::notice::Sem o id da Application no environment do GitHub (DOKPLOY_<PAPEL>_APPLICATION_ID, docs/deploy.md):${absent} não são implantados; a tag de cada um segue o digest da API no fim do run."
  fi
}

follow() {
  local role status moved=""

  if [ -z "${API_DIGEST:-}" ] || [ -z "${TAG:-}" ]; then
    echo "::error::deploy-roles.sh precisa de TAG e API_DIGEST." >&2
    exit 1
  fi

  for role in "${ROLES[@]}"; do
    status=$(status_of "$role")

    # Deployed: its tag already moved, right before its deploy.
    [ "$status" = "deployed" ] && continue

    # A role's tag is a convenience for an Application that does not
    # deploy here yet: GHCR not answering must not turn a deploy that
    # converged into a red run.
    if bash .github/scripts/ghcr.sh tag "${REPO}:${TAG}-${role}" "${REPO}@${API_DIGEST}"; then
      moved="$moved ${TAG}-${role}"
    else
      echo "::warning::A tag trajetto-api:${TAG}-${role} não andou (o GHCR não respondeu); ela fica no build anterior até o próximo deploy."
    fi
  done

  if [ -n "$moved" ]; then
    summary "Papéis sem Application implantada, tags no digest da API (${API_DIGEST}):${moved}"
  fi
}

restore() {
  local role status previous

  if [ "${RESTORE_TAGS:-false}" != "true" ]; then
    return 0
  fi

  if [ -z "$STATE_FILE" ] || [ ! -f "$STATE_FILE" ]; then
    return 0
  fi

  while read -r role status previous; do
    [ "$status" = "failed" ] || continue

    if [ -z "$previous" ] || [ "$previous" = "-" ]; then
      echo "::warning::trajetto-api:${TAG}-${role} não existia antes deste run; fica onde está."
      continue
    fi

    bash .github/scripts/ghcr.sh tag "${REPO}:${TAG}-${role}" "${REPO}@${previous}"
    summary "trajetto-api:${TAG}-${role} voltou para ${previous} (o deploy falhou; o papel segue no build anterior)."
  done < "$STATE_FILE"
}

case "${1:-}" in
  before-api) deploy_phase "${BEFORE_API[@]}" ;;
  after-api) deploy_phase "${AFTER_API[@]}" ;;
  follow) follow ;;
  restore) restore ;;
  *) usage ;;
esac
