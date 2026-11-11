#!/usr/bin/env bash
#
# Did the staging validation of a commit pass? The `Staging evidence` jobs of
# pr.yml and production.yml ask it here: about the commit whose build ships
# (the one staged-build.sh answers) and, when that is an older commit — the
# head only adds documentation to it — about the head too, whose own run
# validated that documentation (`Docs`).
#
#   check-gate.sh <commit>
#
# Reads the commit's check runs from the GitHub API (gh, with GH_TOKEN, in
# GITHUB_REPOSITORY) and looks for staging.yml's `Gate`, from the
# github-actions app, completed with success, in a run of staging.yml on
# the staging branch (the workflow run of the check's suite: its path and
# branch). A job of that name in any other workflow, or a run of staging.yml
# on another branch, does not count. The `staged-<7>` marker already says
# staging deployed the build; this says the validation that let it through
# was green, so a marker written by hand, or by a run whose gate was
# skipped, does not reach production. Builds made before staging.yml existed
# carry the old pipeline's job instead, "Lint, type-check, unit (coverage
# floor) and E2E" of deploy.yml (on the staging branch, pushed or as the
# pull request's head), which gated the same validation, and it counts for
# them.
#
# Only the latest run of each check counts (the API's default): a re-run
# that failed after a green one is red.
#
# GATE_WAIT_ROUNDS (default 0) waits for a Gate that has not finished, or
# not started (the run is still validating), reading again every
# GATE_WAIT_SECONDS (default 30): the head's own run may still be in `Docs`.
#
# Exit status:
#   0  the gate passed;
#   3  it did not: failed, cancelled or skipped, or green only from
#      somewhere else (stderr says which);
#   4  not yet, after the wait: queued, running, or no Gate at all (the run
#      never reached it, or there is none);
#   1  the GitHub API did not answer after GATE_ATTEMPTS tries (default 3,
#      pausing GATE_RETRY_SECONDS, default 10, times the attempt), or a bad
#      argument.
set -euo pipefail
shopt -s inherit_errexit

ATTEMPTS=${GATE_ATTEMPTS:-3}
PAUSE=${GATE_RETRY_SECONDS:-10}
ROUNDS=${GATE_WAIT_ROUNDS:-0}
WAIT=${GATE_WAIT_SECONDS:-30}
REPO=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY ausente}

commit=${1:-}

if [[ ! "$commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::check-gate.sh precisa do sha completo do commit (40 caracteres hexadecimais); recebido: '${commit}'." >&2
  exit 1
fi

GATE="Gate"
GATE_WORKFLOW=".github/workflows/staging.yml"
LEGACY="Lint, type-check, unit (coverage floor) and E2E"
LEGACY_WORKFLOW=".github/workflows/deploy.yml"
BRANCH="staging"

# One read of the GitHub API, tried again; exits 1 when it never answers.
api() {
  local path=$1 filter=$2 what=$3 attempt answer

  for ((attempt = 1; attempt <= ATTEMPTS; attempt++)); do
    if answer=$(gh api --paginate "repos/${REPO}/${path}" --jq "$filter"); then
      printf '%s' "$answer"
      return 0
    fi
    if [ "$attempt" -eq "$ATTEMPTS" ]; then
      echo "::error::A API do GitHub não respondeu ${what} de ${commit:0:7} depois de ${ATTEMPTS} tentativas. Não é um problema do código; nada foi decidido com base nessa leitura." >&2
      exit 1
    fi
    echo "::warning::A API do GitHub falhou ao ler ${what} de ${commit:0:7} (tentativa ${attempt} de ${ATTEMPTS}). De novo em $((PAUSE * attempt))s." >&2
    sleep $((PAUSE * attempt))
  done
}

# The workflow file and the branch of the run that made check suite $1:
# "<path><TAB><branch>", the path without the `@<ref>` the API may add.
origin_of() {
  local answer path

  answer=$(api "actions/runs?check_suite_id=${1}" \
    '.workflow_runs[0] // {} | [(.path // ""), (.head_branch // "")] | @tsv' \
    "a origem do check") || return 1
  path=${answer%%$'\t'*}
  printf '%s\t%s' "${path%%@*}" "${answer#*$'\t'}"
}

# 0 passed, 3 refused, 4 not yet, 1 the API did not answer; stderr says why.
# Called as `verdict || code=$?`, where errexit does not reach inside: every
# read checks its own status.
verdict() {
  local runs seen="" pending="" name status conclusion suite origin want

  runs=$(api "commits/${commit}/check-runs?per_page=100" \
    '.check_runs[] | select(.app.slug == "github-actions") | [.name, .status, (.conclusion // ""), ((.check_suite.id // "") | tostring)] | @tsv' \
    "os checks") || return 1

  while IFS=$'\t' read -r name status conclusion suite; do
    case "$name" in
      "$GATE") want="${GATE_WORKFLOW}" ;;
      "$LEGACY") want="${LEGACY_WORKFLOW}" ;;
      *) continue ;;
    esac
    if [ "$status" != completed ]; then
      pending="${pending} \"${name}\" (${status})"
      continue
    fi
    if [ "$conclusion" != success ]; then
      seen="${seen} \"${name}\" (${conclusion})"
      continue
    fi
    origin=$(origin_of "$suite") || return 1
    # No run for the suite: the filter prints an empty path and branch.
    [ -n "${origin//$'\t'/}" ] || origin=$'nenhum workflow\tnenhuma'
    if [ "$origin" != "${want}"$'\t'"${BRANCH}" ]; then
      seen="${seen} \"${name}\" verde, mas de ${origin%%$'\t'*} na branch ${origin#*$'\t'}, não de ${want} na ${BRANCH}"
      continue
    fi
    echo "${commit:0:7}: o check \"${name}\" da validação de staging passou." >&2
    if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
      echo "Validação de staging de \`${commit:0:7}\`: \"${name}\" verde." >> "$GITHUB_STEP_SUMMARY"
    fi
    return 0
  done <<< "$runs"

  if [ -n "$pending" ]; then
    echo "A validação de staging de ${commit:0:7} ainda não terminou:${pending}." >&2
    return 4
  fi
  if [ -n "$seen" ]; then
    echo "A validação de staging de ${commit:0:7} não passou:${seen}." >&2
    return 3
  fi
  echo "${commit:0:7} não tem o check \"${GATE}\" da validação de staging (o run de staging dele não chegou ao Gate)." >&2
  return 4
}

for ((round = 0; ; round++)); do
  code=0
  verdict || code=$?
  if [ "$code" -ne 4 ] || [ "$round" -ge "$ROUNDS" ]; then
    exit "$code"
  fi
  echo "Esperando o Gate de ${commit:0:7} (rodada $((round + 1)) de ${ROUNDS}); de novo em ${WAIT}s." >&2
  sleep "$WAIT"
done
