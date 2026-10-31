#!/usr/bin/env bash
#
# Does going from one commit to another change only documentation? The one
# place that answers it for deploy.yml: staged-build.sh (the PR check and the
# promote) and the staging deploy's branch-head check ask it here.
#
#   docs-only.sh <from> <to>
#
# Documentation is any `*.md` file, anywhere, and anything under `docs/`
# (the web's docs-only.mjs and the app's deploy.yml use the same rule). No
# image carries those: the API's .dockerignore leaves them out, and the AI's
# Dockerfile copies named files only. So two commits that differ only in
# them build the same image content.
#
# Exit status:
#   0  only documentation changed (or nothing did);
#   1  something else changed: stdout lists those paths, one per line;
#   2  git could not compare the two (a commit the checkout does not have).
#
# --no-renames: a file moved from src/ into docs/ is a change to src/. With
# quotePath off, a pt-BR name (docs/decisões.md) comes as itself instead of
# quoted and escaped, which would read as "not documentation". Only trees
# are compared, so a blobless checkout is enough.
set -euo pipefail

from=${1:-}
to=${2:-}

if [ -z "$from" ] || [ -z "$to" ]; then
  echo "uso: docs-only.sh <commit-de> <commit-para>" >&2
  exit 2
fi

if ! changed=$(git -c core.quotePath=false diff --no-renames --name-only "$from" "$to"); then
  echo "::error::git não conseguiu comparar ${from} com ${to}." >&2
  exit 2
fi

others=""

while IFS= read -r path; do
  [ -n "$path" ] || continue
  case "$path" in
    docs/* | *.md) ;;
    *) others="${others}${path}"$'\n' ;;
  esac
done <<< "$changed"

if [ -n "$others" ]; then
  printf '%s' "$others"
  exit 1
fi

exit 0
