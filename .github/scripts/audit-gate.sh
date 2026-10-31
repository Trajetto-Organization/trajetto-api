#!/usr/bin/env bash
#
# The dependency audit of ci.yml and deploy.yml (INFRA-16): audit-ci fails on
# a CRITICAL advisory in a production dependency (audit-ci.jsonc). Here is
# decided whether that verdict BLOCKS this run.
#
# The advisory database changes every day, with no commit of ours: a CRITICAL
# published this morning failed the next push of any commit, a docs fix
# included, and the same commit that passed yesterday failed today. Now:
#
# - the push or pull request changes what the audit reads (a package.json,
#   yarn.lock or package-lock.json anywhere, or audit-ci.jsonc itself):
#   the verdict blocks, as before — that change is what brings the advisory
#   in, or takes an exception out;
# - it does not: the audit still runs, and a failure is a ::warning:: and a
#   line in the job summary, never a red run. The advisory is already in the
#   tree that is running; Dependabot (alerts and security updates) is the
#   watch that opens the fix, and the next change to the dependencies has to
#   pass this gate for real.
#
# What it compares (AUDIT_BASE): the pull request's base, or the push's
# `before`. With no base to compare — a new branch (`before` all zeros), a
# Run workflow, a base that is not in this checkout (a force push, a shallow
# clone) — the answer is "changed", and the verdict blocks.
#
# A verdict and a failure to audit are told apart. audit-ci says "Failed
# security audit due to ..." when it found an advisory; any other non-zero
# exit is the audit not running at all — the registry's audit endpoint
# down (audit-ci 7.1.0 retries, with no pause, only a "503 Service
# Unavailable"; a reset connection or a 502 came out as the same exit 1 as a
# CRITICAL, and a blocking run told the author to update a dependency). That
# one is tried again, AUDIT_ATTEMPTS times in all (default 3) with growing
# pauses and a ::warning:: each; when it persists, it is reported as what it
# is: blocking only where the verdict would block (the dependencies changed
# and could not be audited), never read as an advisory.
#
# Environment:
#   AUDIT_BASE   the commit to compare with (may be empty)
#   GITHUB_SHA   the commit under audit
#   AUDIT_CMD    the audit command (default: the audit-ci of yarn.lock, a
#                pinned devDependency installed with the rest, with the
#                repository's config; an `npx --yes audit-ci@x` resolved
#                its transitive dependencies anew on every run); the tests
#                replace it
#   AUDIT_ATTEMPTS, AUDIT_RETRY_SECONDS   the retries of a failure to audit
set -euo pipefail

CMD=${AUDIT_CMD:-./node_modules/.bin/audit-ci --config audit-ci.jsonc}
BASE=${AUDIT_BASE:-}
HEAD=${GITHUB_SHA:?GITHUB_SHA ausente}
ATTEMPTS=${AUDIT_ATTEMPTS:-3}
PAUSE=${AUDIT_RETRY_SECONDS:-10}

# audit-ci's own words when it found an advisory over the threshold.
VERDICT='Failed security audit due to'

# What the audit's verdict depends on.
MANIFESTS=(
  ':(glob)**/package.json'
  ':(glob)**/yarn.lock'
  ':(glob)**/package-lock.json'
  'audit-ci.jsonc'
)

summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '%s\n' "$1" >> "$GITHUB_STEP_SUMMARY"
  fi
}

blocking=true

if [ -z "$BASE" ] || [[ "$BASE" =~ ^0+$ ]]; then
  why="sem commit de base para comparar (branch nova ou Run workflow)"
elif ! git cat-file -e "${BASE}^{commit}" 2> /dev/null; then
  why="o commit de base ${BASE:0:7} não está neste checkout"
elif ! changed=$(git diff --name-only "$BASE" "$HEAD" -- "${MANIFESTS[@]}"); then
  why="o git não conseguiu comparar ${BASE:0:7} com ${HEAD:0:7}"
elif [ -n "$changed" ]; then
  why="muda $(printf '%s' "$changed" | paste -sd ',' - | sed 's/,/, /g')"
else
  blocking=false
  why="não muda package.json, yarn.lock, package-lock.json nem audit-ci.jsonc desde ${BASE:0:7}"
fi

if [ "$blocking" = true ]; then
  echo "Auditoria de dependências: bloqueia este run (${why})."
else
  echo "Auditoria de dependências: só relata neste run (${why})."
fi

log=$(mktemp)
trap 'rm -f "$log"' EXIT

status=0
for ((attempt = 1; attempt <= ATTEMPTS; attempt++)); do
  status=0
  # shellcheck disable=SC2086 # the command is a word list on purpose
  $CMD 2>&1 | tee "$log" || status=$?

  # Passed, or a verdict: an answer either way.
  if [ "$status" -eq 0 ] || grep -qF "$VERDICT" "$log"; then
    break
  fi

  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    wait_for=$((PAUSE * attempt))
    echo "::warning::O audit-ci não conseguiu auditar (código ${status}; tentativa ${attempt} de ${ATTEMPTS}): rede ou registry, não um aviso de segurança. De novo em ${wait_for}s."
    sleep "$wait_for"
  fi
done

if [ "$status" -eq 0 ]; then
  summary "Auditoria de dependências (audit-ci): nenhum CRITICAL de produção fora da allowlist."
  exit 0
fi

if ! grep -qF "$VERDICT" "$log"; then
  if [ "$blocking" = true ]; then
    echo "::error::O audit-ci não conseguiu auditar depois de ${ATTEMPTS} tentativas (código ${status}): o npm/registry não respondeu. Não é um aviso de segurança, mas este run ${why}, e uma mudança de dependência não passa sem auditoria. Detalhes no log deste passo."
    summary "Auditoria de dependências: **não rodou** (rede ou registry, código ${status}, depois de ${ATTEMPTS} tentativas); bloqueia porque o run ${why}."
    exit "$status"
  fi
  echo "::warning::O audit-ci não conseguiu auditar depois de ${ATTEMPTS} tentativas (código ${status}): rede ou registry, não um aviso de segurança. Não bloqueia: este run ${why}."
  summary "Auditoria de dependências: **não rodou** (rede ou registry, código ${status}, depois de ${ATTEMPTS} tentativas); não bloqueia (o run ${why})."
  exit 0
fi

if [ "$blocking" = true ]; then
  echo "::error::A auditoria de dependências reprovou (audit-ci, código ${status}), e este run ${why}: o portão bloqueia. Atualize a dependência, ou registre a exceção com motivo e data em audit-ci.jsonc."
  summary "Auditoria de dependências: **reprovou e bloqueou** (código ${status}; o run ${why})."
  exit "$status"
fi

echo "::warning::A auditoria de dependências reprovou (audit-ci, código ${status}), mas este run ${why}: não bloqueia. O aviso já está na árvore que roda; o Dependabot abre a correção, e a próxima mudança de dependência passa por este portão de verdade. Detalhes no log deste passo."
{
  summary "Auditoria de dependências: **reprovou, sem bloquear** (código ${status}; o run ${why})."
  summary ""
  summary '```'
  summary "$(tail -n 40 "$log")"
  summary '```'
}
exit 0
