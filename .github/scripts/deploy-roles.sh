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
#   deploy-roles.sh held         the roles this run held on their build
#                                (the realtime, F3-31c), comma-separated
#   deploy-roles.sh verify before-api | after-api
#                                the proof the roles this run deployed came
#                                up on the build: over SSH (X-07), one call
#                                of infra/scripts/verify-rollout.sh per role,
#                                in the deploy's order; with VERIFY_MODE=http,
#                                /health/rollout through the API
#                                (wait-for-roles.mjs, scope `roles`)
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
# The realtime (plano-escala F3-31c, decision D7) is deployed only when
# what it runs changed, because its deploy drops every socket: the image
# carries `trajetto.realtime-source` (its import closure, the dependencies,
# the schema) and `trajetto.contract-epoch` (the contractions and the
# versions of the messages between processes), from
# .github/scripts/realtime-closure.mjs. It is deployed with FORCE_REALTIME,
# when the image it runs has no labels (or no tag yet), when either label
# differs, or when that image is older than REALTIME_MAX_LAG_DAYS (7);
# otherwise it is `held`: it keeps its tag and its build, and the run says
# why in the summary. The roles' convergence check is told to accept it on
# its older commit (ROLLOUT_ROLES_HELD, wait-for-roles.mjs).
#
# The state of each role is written to STATE_FILE, one `<role> <status>
# <previous digest or ->` per line (status: deployed, failed, absent,
# held), for the `follow` and `restore` phases of the same run. Without
# STATE_FILE, nothing was recorded and both phases find nothing to do.
#
# Environment: TAG, API_DIGEST, STATE_FILE, RESTORE_TAGS, DOKPLOY_ENABLED
# (`true` when the environment has Dokploy), DOKPLOY_URL, DOKPLOY_API_KEY,
# DOKPLOY_WORKER_APPLICATION_ID, DOKPLOY_SCHEDULER_APPLICATION_ID,
# DOKPLOY_WORKER_EXTERNAL_APPLICATION_ID, DOKPLOY_INGEST_APPLICATION_ID and
# DOKPLOY_REALTIME_APPLICATION_ID. DEPLOY_SCRIPT is dokploy-deploy.mjs.
# The realtime's: FORCE_REALTIME (`true` deploys it whatever the labels),
# REALTIME_MAX_LAG_DAYS (default 7) and NOW_EPOCH (the clock, for tests).
# The `verify` phase: VERIFY_MODE (`ssh`, the default, or `http`); over
# SSH, SSH_TARGET (`user@host`), SSH_KEY_FILE (default ~/.ssh/verify_key,
# written by the action's SSH step) and each role's App Name in
# SWARM_<ROLE>_SERVICE (SWARM_WORKER_EXTERNAL_SERVICE...); over http,
# wait-for-roles.mjs's own (API_URL, ROLLOUT_STATUS_TOKEN, EXPECTED_SHA),
# run as WAIT_ROLES_SCRIPT (default .github/scripts/wait-for-roles.mjs).
set -euo pipefail

REPO=ghcr.io/trajetto-organization/trajetto-api
DEPLOY_SCRIPT=${DEPLOY_SCRIPT:-.github/scripts/dokploy-deploy.mjs}
STATE_FILE=${STATE_FILE:-}

BEFORE_API=(worker scheduler worker-external)
AFTER_API=(ingest realtime)
ROLES=("${BEFORE_API[@]}" "${AFTER_API[@]}")

usage() {
  echo "uso: deploy-roles.sh before-api | after-api | follow | restore | held | verify before-api|after-api" >&2
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

# SWARM_WORKER_EXTERNAL_SERVICE for worker-external: the role's App Name.
service_of() {
  local name
  name="SWARM_$(printf '%s' "$1" | tr '[:lower:]-' '[:upper:]_')_SERVICE"
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

# Whether the realtime must be deployed: `deploy <reason>` or `held
# <reason>` on stdout. Reads the labels of the image its tag names now and
# of the API's new one; GHCR not answering fails the step, as any read of
# a tag does, before anything moved.
realtime_verdict() {
  local current fresh source epoch created new_source new_epoch now age days
  local max_days=${REALTIME_MAX_LAG_DAYS:-7}
  local names=(trajetto.realtime-source trajetto.contract-epoch org.opencontainers.image.created)

  if [ "${FORCE_REALTIME:-false}" = "true" ]; then
    echo "deploy force-realtime"
    return 0
  fi

  current=$(bash .github/scripts/ghcr.sh labels "${REPO}:${TAG}-realtime" "${names[@]}") || return 1

  if [ -z "$current" ]; then
    echo "deploy a tag ${TAG}-realtime ainda não existe"
    return 0
  fi

  fresh=$(bash .github/scripts/ghcr.sh labels "${REPO}@${API_DIGEST}" "${names[@]}") || return 1

  IFS='|' read -r source epoch created <<< "$current"
  IFS='|' read -r new_source new_epoch _ <<< "$fresh"

  if [ -z "$source" ] || [ -z "$epoch" ]; then
    echo "deploy a imagem em uso não tem os labels do realtime (a primeira com eles sempre implanta)"
  elif [ -z "$new_source" ] || [ -z "$new_epoch" ]; then
    echo "deploy a imagem nova não tem os labels do realtime"
  elif [ "$new_epoch" != "$epoch" ]; then
    echo "deploy a época de contract mudou (${epoch} → ${new_epoch})"
  elif [ "$new_source" != "$source" ]; then
    echo "deploy o código que o realtime executa mudou"
  else
    now=${NOW_EPOCH:-$(date -u +%s)}

    if ! age=$(date -u -d "$created" +%s 2>/dev/null) || [ -z "$created" ]; then
      echo "deploy a idade da imagem em uso não se lê (org.opencontainers.image.created='${created}')"
      return 0
    fi

    days=$(((now - age) / 86400))

    if [ "$days" -gt "$max_days" ]; then
      echo "deploy a imagem em uso tem ${days} dias (o máximo é ${max_days})"
    else
      echo "held fonte e época iguais (época ${epoch}), imagem em uso com ${days} dia(s)"
    fi
  fi
}

deploy_phase() {
  local role id previous verdict absent=""

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

    if [ "$role" = realtime ]; then
      if ! verdict=$(realtime_verdict); then
        echo "::error::Não deu para ler os labels da trajetto-realtime no GHCR: nada depois dela foi implantado."
        exit 1
      fi

      if [ "${verdict%% *}" = held ]; then
        record "$role" held "$previous"
        echo "::notice::trajetto-realtime não foi implantada: ${verdict#* }. Ela segue em ${previous}; FORCE_REALTIME (Run workflow com force_realtime) implanta mesmo assim."
        summary "trajetto-realtime mantida em ${previous}: ${verdict#* }."
        continue
      fi

      summary "trajetto-realtime implantada: ${verdict#* }."
    fi

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

    # Deployed: its tag already moved, right before its deploy. Held (the
    # realtime whose code did not change): its tag stays on its build.
    [ "$status" = "deployed" ] && continue
    [ "$status" = "held" ] && continue

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

# The proof each role deployed by this run converged, as the API's own
# check over SSH (plano-escala X-07): Dokploy's `done` only means the
# manager accepted the spec, and a role whose new task failed its
# healthcheck is rolled back by Swarm with the old build still running.
# One call of the host's verify-rollout per role, in the deploy's order,
# with the API's digest (every role runs the API's image). A role that was
# not deployed (absent, or failed: the run is red already) is not checked;
# a deployed one without its SWARM_<ROLE>_SERVICE is a warning, never a
# guess at its name. A role that does not converge fails the step, and the
# checks after it do not run.
verify_phase() {
  local role service checked=""

  if [ "${VERIFY_MODE:-ssh}" = "http" ]; then
    verify_http "$@"
    return
  fi

  if [ "${VERIFY_MODE:-ssh}" != "ssh" ]; then
    echo "::error::VERIFY_MODE precisa ser ssh ou http (recebido: '${VERIFY_MODE}')." >&2
    exit 1
  fi

  if [ -z "${API_DIGEST:-}" ] || [ -z "${SSH_TARGET:-}" ]; then
    echo "::error::deploy-roles.sh verify precisa de API_DIGEST e SSH_TARGET." >&2
    exit 1
  fi

  for role in "$@"; do
    [ "$(status_of "$role")" = "deployed" ] || continue

    service=$(service_of "$role")

    if [ -z "$service" ]; then
      echo "::warning::trajetto-${role} foi implantada, mas falta a variável SWARM_$(printf '%s' "$role" | tr '[:lower:]-' '[:upper:]_')_SERVICE (o App Name dela) no environment do GitHub: a conferência por SSH dela não roda (docs/deploy.md, seção 14)."
      continue
    fi

    if ! ssh -i "${SSH_KEY_FILE:-$HOME/.ssh/verify_key}" -o BatchMode=yes \
      -o StrictHostKeyChecking=yes -o ServerAliveInterval=30 \
      -o ServerAliveCountMax=6 \
      "$SSH_TARGET" "$service ${REPO}@${API_DIGEST}"; then
      echo "::error::trajetto-${role} (${service}) não convergiu para ${API_DIGEST}: o Swarm reverteu o update ou ele não terminou no prazo. Detalhe no host: docker service ps --no-trunc ${service}."
      exit 1
    fi

    checked="$checked $service"
    summary "trajetto-${role}: ${service} convergiu para ${API_DIGEST}."
  done

  if [ -n "$checked" ]; then
    echo "[deploy-roles] conferidos por SSH:${checked}"
  fi
}

# The same proof without SSH (staging's default check): the API still on
# the previous build answers /health/rollout for the roles this run
# deployed, and wait-for-roles.mjs, scoped to them, waits until each has a
# live process on the new commit and none on another, for its window. A
# worker whose new task refused to boot (F3-01) never gets there, and the
# step fails before the API's tag moves. Nothing deployed, nothing to wait
# for; no token, or an API too old to answer, and the script steps aside
# with a notice, as the check after the API does.
verify_http() {
  local role deployed=""

  for role in "$@"; do
    if [ "$(status_of "$role")" = "deployed" ]; then
      deployed="${deployed:+$deployed,}$role"
    fi
  done

  if [ -z "$deployed" ]; then
    echo "[deploy-roles] nenhum papel implantado nesta fase: nada a conferir."
    return 0
  fi

  ROLLOUT_ROLES_EXPECTED="$deployed" WAIT_ROLES_SCOPE=roles \
    node "${WAIT_ROLES_SCRIPT:-.github/scripts/wait-for-roles.mjs}"
}

# The roles held on their build in this run, comma-separated, for
# wait-for-roles.mjs (ROLLOUT_ROLES_HELD).
held() {
  if [ -n "$STATE_FILE" ] && [ -f "$STATE_FILE" ]; then
    awk '$2 == "held" { printf "%s%s", (n++ ? "," : ""), $1 } END { print "" }' "$STATE_FILE"
  fi
}

case "${1:-}" in
  before-api) deploy_phase "${BEFORE_API[@]}" ;;
  after-api) deploy_phase "${AFTER_API[@]}" ;;
  verify)
    case "${2:-}" in
      before-api) verify_phase "${BEFORE_API[@]}" ;;
      after-api) verify_phase "${AFTER_API[@]}" ;;
      *) usage ;;
    esac
    ;;
  follow) follow ;;
  restore) restore ;;
  held) held ;;
  *) usage ;;
esac
