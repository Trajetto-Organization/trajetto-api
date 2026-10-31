#!/usr/bin/env bash
#
# Which staging build covers a commit: the PR check (`staging-image`) and the
# promote (`promote-production`) of deploy.yml ask the same question here.
#
#   staged-build.sh <commit>
#
# Prints, on stdout, the full sha of the commit whose build the merge
# promotes:
#
# - <commit> itself, when staging deployed it: `staged-<7>` on the same
#   digest as `sha-<7>`, for every image. An image with neither tag (the AI,
#   for builds older than the service) is left out, with a warning; the
#   first image (the API) never is.
# - Otherwise, the nearest ancestor staging deployed, when everything that
#   changed between the two is documentation: a `*.md` file anywhere, or
#   anything under `docs/` (docs-only.sh, the one place with that rule). No
#   image carries those (.dockerignore), so the
#   ancestor's build IS this commit's build, and a commit like that may skip
#   CI (`[skip ci]`) and still be promoted (docs/deploy.md, "Commits só de
#   documentação"). The ancestors are walked along the first parents, up to
#   STAGED_DEPTH (default 50), and the walk stops at the first one whose
#   difference is more than documentation: past it, every older build lacks
#   that change too.
#
# Exit status:
#   0  found (stdout: the sha; with GITHUB_OUTPUT set, also `commit=` and
#      `tag=sha-<7>` there);
#   3  not (yet): staging has not deployed <commit> and the documentation
#      rule does not cover it — stderr says why. The PR check keeps waiting
#      on 3; the promote refuses;
#   4  refused: a `staged-<7>` names another digest than `sha-<7>`;
#   1  GHCR or git failed (ghcr.sh already said which).
#
# Messages go to stderr (the runner reads workflow commands there too).
set -euo pipefail
shopt -s inherit_errexit

REPOSITORY=${GHCR_REPOSITORY:-ghcr.io/trajetto-organization}
IMAGES=${STAGED_IMAGES:-trajetto-api trajetto-ai}
DEPTH=${STAGED_DEPTH:-50}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

commit=${1:-}

if [[ ! "$commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::staged-build.sh precisa do sha completo do commit (40 caracteres hexadecimais); recebido: '${commit}'." >&2
  exit 1
fi

digest() {
  bash "$HERE/ghcr.sh" digest "$1"
}

# What staging did with <sha>: "staged", "missing", or "mismatch <image>
# <staged> <built>". Returns 1 when GHCR does not answer.
state_of() {
  local short=${1:0:7} image built staged first=true

  for image in $IMAGES; do
    built=$(digest "${REPOSITORY}/${image}:sha-${short}") || return 1
    staged=$(digest "${REPOSITORY}/${image}:staged-${short}") || return 1

    if [ "$first" = false ] && [ -z "$built" ] && [ -z "$staged" ]; then
      echo "absent ${image}"
      first=false
      continue
    fi

    first=false

    if [ -z "$built" ] || [ -z "$staged" ]; then
      echo missing
      return 0
    fi

    if [ "$staged" != "$built" ]; then
      echo "mismatch ${image} ${staged} ${built}"
      return 0
    fi
  done

  echo staged
}

# Did state_of say staged? Its output may carry "absent <image>" lines
# before the verdict.
verdict() {
  printf '%s\n' "$1" | tail -n 1
}

found() {
  local sha=$1 how=$2

  printf '%s\n' "$sha"

  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    {
      echo "commit=${sha}"
      echo "tag=sha-${sha:0:7}"
    } >> "$GITHUB_OUTPUT"
  fi

  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "$how" >> "$GITHUB_STEP_SUMMARY"
  fi

  exit 0
}

warn_absent() {
  local line
  while IFS= read -r line; do
    case "$line" in
      "absent "*)
        echo "::warning::${line#absent }:sha-${2:0:7} não existe (build anterior a esse serviço); nada a conferir para ${line#absent }." >&2
        ;;
    esac
  done <<< "$1"
}

# --- the commit itself -------------------------------------------------------

own=$(state_of "$commit") || exit 1
warn_absent "$own" "$commit"

case "$(verdict "$own")" in
  staged)
    found "$commit" "staged-${commit:0:7}: o staging rodou este build."
    ;;
  mismatch*)
    read -r _ image staged built <<< "$(verdict "$own")"
    echo "::error::${REPOSITORY}/${image}:staged-${commit:0:7} aponta para ${staged}, não para ${built} de ${image}:sha-${commit:0:7}: recusado (o build foi refeito depois do deploy de staging; espere o deploy de staging do build novo)." >&2
    exit 4
    ;;
esac

# --- not deployed: is it only documentation since a build that was? ----------

if ! ancestors=$(git rev-list --first-parent --max-count="$((DEPTH + 1))" "$commit" 2> /dev/null); then
  echo "::error::git não conhece o commit ${commit} (o checkout precisa do histórico completo: fetch-depth: 0)." >&2
  exit 1
fi

first=true

while IFS= read -r ancestor; do
  if [ "$first" = true ]; then
    first=false
    continue
  fi

  # docs-only.sh: 0 only documentation, 1 more (stdout: those paths), 2 git
  # failed (it said so on stderr).
  status=0
  others=$(bash "$HERE/docs-only.sh" "$ancestor" "$commit") || status=$?

  case "$status" in
    0) ;;
    1)
      code=$(printf '%s' "$others" | paste -sd ',' - | sed 's/,/, /g' | cut -c1-500)
      echo "O staging não rodou ${commit:0:7}, e desde ${ancestor:0:7} mudou mais que documentação: ${code}. Só um commit que muda apenas *.md ou docs/ pode ir para a produção sem o pipeline de staging." >&2
      exit 3
      ;;
    *) exit 1 ;;
  esac

  theirs=$(state_of "$ancestor") || exit 1

  case "$(verdict "$theirs")" in
    staged)
      warn_absent "$theirs" "$ancestor"
      echo "::notice::${commit:0:7} só muda documentação desde ${ancestor:0:7}, que o staging rodou: o build promovido é o de ${ancestor:0:7}." >&2
      found "$ancestor" "${commit:0:7} só muda documentação desde ${ancestor:0:7} (\`staged-${ancestor:0:7}\`): o build promovido é \`sha-${ancestor:0:7}\`, o mesmo conteúdo de imagem."
      ;;
  esac
done <<< "$ancestors"

echo "O staging não rodou ${commit:0:7}, e nenhum dos ${DEPTH} ancestrais mais próximos que diferem dele só em documentação tem o marcador staged-<7>." >&2
exit 3
