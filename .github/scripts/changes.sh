#!/usr/bin/env bash
#
# What a push changes, for the `Changes` job of ci.yml and staging.yml.
#
#   changes.sh staging|branch
#
# Writes to GITHUB_OUTPUT (and says why in the job summary):
#
#   docs=true|false
#     true when every file in the range is documentation (docs-only.sh:
#     `*.md` anywhere, anything under `docs/`, which no image carries). Such a
#     push runs only the secret scan and the `Docs` job: no E2E, no image, no
#     deploy. Validation always runs on the whole tree, so what is left to
#     decide is only whether there is anything but documentation to
#     validate. With no range to compare — Run workflow, a commit the
#     checkout does not have, git failing — it is code, and everything runs.
#     The range:
#     - staging: the push's own (BEFORE..GITHUB_SHA). A documentation push
#       there validates in a group of its own and cancels nothing
#       (staging.yml), so a code push under it still validates and deploys;
#     - branch: everything the branch changes since it left staging
#       (merge-base with origin/staging). A newer push on a work branch
#       cancels the whole older run (ci.yml), so a documentation push on top
#       of a code push must still validate that code: the push's own range
#       would let the branch reach staging with its code never validated.
#
#   audit_base=<sha>|
#     the commit the dependency audit compares with (audit-gate.sh). On
#     staging, the last build staging SERVED (`staged-<7>` on the digest of
#     `sha-<7>`, the nearest along the first parents): a push whose run was
#     cancelled or failed is in the range of the next one, so a dependency
#     change never slips past the blocking audit because the run that should
#     have blocked it did not finish. On a work branch, the point where it
#     left staging: what the branch changes. Empty when there is none (the
#     audit then blocks); GHCR not answering falls back to the push's
#     `before`, with a warning.
#
# Environment: GITHUB_SHA, BEFORE (the push's `before`, empty on Run
# workflow), GITHUB_OUTPUT, GITHUB_STEP_SUMMARY; STAGED_DEPTH (default 50),
# GHCR_REPOSITORY; GHCR_LOGIN=failed when the job could not log in to GHCR
# (the lookup is skipped, as when GHCR does not answer). GHCR is read
# through ghcr.sh; the checkout needs the history (fetch-depth: 0) and, for
# a branch, origin/staging.
#
# Exit status: 0 always when it decided, 1 when its own arguments are wrong.
set -euo pipefail
shopt -s inherit_errexit

MODE=${1:-}
HEAD=${GITHUB_SHA:?GITHUB_SHA ausente}
BEFORE=${BEFORE:-}
DEPTH=${STAGED_DEPTH:-50}
REPOSITORY=${GHCR_REPOSITORY:-ghcr.io/trajetto-organization}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

case "$MODE" in
  staging | branch) ;;
  *)
    echo "uso: changes.sh staging|branch" >&2
    exit 1
    ;;
esac

output() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then printf '%s\n' "$1" >> "$GITHUB_OUTPUT"; fi
}

summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$1" >> "$GITHUB_STEP_SUMMARY"; fi
}

known() {
  [ -n "$1" ] && [[ ! "$1" =~ ^0+$ ]] && git cat-file -e "${1}^{commit}" 2> /dev/null
}

# Where a work branch left staging: empty when origin/staging is not there.
fork_point() {
  git merge-base HEAD origin/staging 2> /dev/null || true
}

# --- docs or code ------------------------------------------------------------

range=""
if [ "$MODE" = staging ]; then
  if known "$BEFORE"; then range=$BEFORE; fi
elif [ -n "$BEFORE" ]; then
  # Empty only on Run workflow: everything runs, as asked.
  range=$(fork_point)
fi

docs=false
if [ -z "$range" ] && [ "$MODE" = branch ]; then
  why="sem intervalo para comparar (Run workflow, ou sem origin/staging neste checkout): roda tudo"
elif [ -z "$range" ]; then
  why="sem intervalo para comparar (Run workflow, ou o commit anterior não está neste checkout): roda tudo"
else
  status=0
  others=$(bash "$HERE/docs-only.sh" "$range" "$HEAD") || status=$?
  case "$status" in
    0)
      docs=true
      why="só documentação desde ${range:0:7}: roda o secret scan e o Docs, sem build nem deploy"
      ;;
    1)
      # sed, not head: it reads everything, so no SIGPIPE under pipefail.
      first=$(printf '%s\n' "$others" | sed -n '1,3p' | paste -sd ',' - | sed 's/,/, /g')
      why="muda código desde ${range:0:7} (${first}…): roda tudo"
      ;;
    *)
      echo "::warning::Não deu para comparar ${range:0:7} com ${HEAD:0:7}: o run valida tudo."
      why="o git não comparou ${range:0:7} com ${HEAD:0:7}: roda tudo"
      ;;
  esac
fi

output "docs=${docs}"
echo "Mudanças: ${why}."
summary "Mudanças: ${why}."

# --- the audit's base --------------------------------------------------------

# The nearest commit, from HEAD down the first parents, whose build staging
# served. 0 found (stdout: the sha), 3 none within DEPTH, 1 GHCR or git.
last_staged() {
  local commits commit short staged built

  commits=$(git rev-list --first-parent --max-count="$DEPTH" HEAD 2> /dev/null) || return 1

  for commit in $commits; do
    short=${commit:0:7}
    staged=$(bash "$HERE/ghcr.sh" digest "${REPOSITORY}/trajetto-api:staged-${short}") || return 1
    [ -n "$staged" ] || continue
    built=$(bash "$HERE/ghcr.sh" digest "${REPOSITORY}/trajetto-api:sha-${short}") || return 1
    if [ "$staged" = "$built" ]; then
      printf '%s\n' "$commit"
      return 0
    fi
  done

  return 3
}

base=""
if [ "$MODE" = branch ]; then
  base=$(fork_point)
  if [ -n "$base" ]; then
    how="o ponto em que a branch saiu da staging (${base:0:7})"
  else
    how="nenhuma (sem origin/staging neste checkout): o audit bloqueia"
  fi
else
  status=0
  if [ "${GHCR_LOGIN:-}" = failed ]; then
    status=1
  else
    base=$(last_staged) || status=$?
  fi
  case "$status" in
    0) how="o último build que a staging serviu (staged-${base:0:7})" ;;
    3)
      base=""
      how="nenhuma (nenhum dos ${DEPTH} commits anteriores tem staged-<7>): o audit bloqueia"
      ;;
    *)
      base=$BEFORE
      echo "::warning::O GHCR não respondeu ao procurar o último build da staging: o audit compara com o push anterior (${BEFORE:0:7})."
      how="o push anterior (${BEFORE:0:7}), porque o GHCR não respondeu"
      ;;
  esac
fi

output "audit_base=${base}"
echo "Base do audit: ${how}."
summary "Base do audit: ${how}."
