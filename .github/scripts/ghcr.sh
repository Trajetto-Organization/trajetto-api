#!/usr/bin/env bash
#
# Reads and moves tags in GHCR for deploy.yml, telling "this tag does not
# exist" apart from "GHCR did not answer".
#
#   ghcr.sh digest <ref>             the manifest digest of <ref> on stdout,
#                                    or nothing when the tag does not exist
#   ghcr.sh tag <new-ref> <source>   points <new-ref> at <source>,
#                                    registry-side (nothing is pulled)
#
# Every query used to be `imagetools inspect ... 2>/dev/null || true`: a 5xx,
# a timeout or a missing login read as "no such tag". The AI was rebuilt for
# nothing, staging lost the digest a failed deploy puts back, the promote
# blamed a squash merge for a registry hiccup, and the check that staging ran
# the AI image was skipped (fail-open). Now only GHCR's own "not found"
# (MANIFEST_UNKNOWN, NAME_UNKNOWN) is an empty answer. Anything else is tried
# again, GHCR_ATTEMPTS times in all (default 5), pausing GHCR_RETRY_SECONDS
# (default 5) and doubling it, with a ::warning:: per retry; when it
# persists, the script fails with an ::error:: that says GHCR is the problem.
#
# Moving a tag is idempotent (the same digest under the same name), so a
# failed `tag` is retried the same way.
#
# Only the answer goes to stdout (callers read it with $(...)); every message
# goes to stderr, where the runner reads workflow commands too.
set -euo pipefail

ATTEMPTS=${GHCR_ATTEMPTS:-5}
PAUSE=${GHCR_RETRY_SECONDS:-5}

usage() {
  echo "uso: ghcr.sh digest <ref> | ghcr.sh tag <nova-ref> <origem>" >&2
  exit 2
}

# GHCR's "there is no such manifest or repository", as buildx prints it.
absent() {
  grep -qiE 'not found|manifest unknown|manifest_unknown|name unknown|name_unknown' "$1"
}

# The manifest digest in what `imagetools inspect --format
# '{{.Manifest.Digest}}'` printed. The buildx of the runners renders the
# template: the bare digest. Newer buildx (0.30) prints the manifest header
# instead for any template that starts with `{{.Manifest` — "Name:",
# "MediaType:", "Digest:" and, for an index (every image here carries an
# SBOM and provenance), its manifests, none of which has a "Digest:" line of
# its own. Both are read; anything else is no digest. A runner image that
# moves buildx forward must not turn every read into "GHCR did not answer".
digest_in() {
  local text bare
  text=$(printf '%s' "$1" | tr -d '\r')
  bare=$(printf '%s' "$text" | tr -d '[:space:]')

  if [[ "$bare" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    printf '%s' "$bare"
    return 0
  fi

  printf '%s\n' "$text" |
    sed -n -E 's/^Digest:[[:space:]]+(sha256:[0-9a-f]{64})[[:space:]]*$/\1/p' |
    sed -n 1p
}

# One line of what went wrong, for a log: the last non-empty line of stderr.
reason() {
  local line
  line=$(grep -v '^[[:space:]]*$' "$1" | tail -n 1 || true)
  printf '%s' "${line:-sem mensagem}" | tr -d '\r' | cut -c1-300
}

err=$(mktemp)
trap 'rm -f "$err"' EXIT

command=${1:-}

case "$command" in
  digest)
    [ $# -eq 2 ] || usage
    ref=$2
    action="ler ${ref}"
    ;;
  tag)
    [ $# -eq 3 ] || usage
    target=$2
    source=$3
    action="apontar ${target} para ${source}"
    ;;
  *) usage ;;
esac

wait_for=$PAUSE

for ((attempt = 1; attempt <= ATTEMPTS; attempt++)); do
  : > "$err"

  if [ "$command" = digest ]; then
    if out=$(docker buildx imagetools inspect "$ref" --format '{{.Manifest.Digest}}' 2> "$err"); then
      found=$(digest_in "$out")
      if [ -n "$found" ]; then
        printf '%s\n' "$found"
        exit 0
      fi
      printf 'resposta ilegível do GHCR: %s\n' "$(printf '%s' "$out" | tr -d '\r' | tr '\n' ' ' | cut -c1-200)" > "$err"
    elif absent "$err"; then
      # The tag does not exist: an answer, not a failure.
      exit 0
    fi
  else
    if docker buildx imagetools create --tag "$target" "$source" > /dev/null 2> "$err"; then
      exit 0
    fi
    if absent "$err"; then
      echo "::error::GHCR: não deu para ${action}: a origem não existe ($(reason "$err"))." >&2
      exit 1
    fi
  fi

  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    echo "::warning::GHCR: falha ao ${action} (tentativa ${attempt} de ${ATTEMPTS}): $(reason "$err"). De novo em ${wait_for}s." >&2
    sleep "$wait_for"
    wait_for=$((wait_for * 2))
  fi
done

echo "::error::GHCR indisponível: não deu para ${action} depois de ${ATTEMPTS} tentativas. Último erro: $(reason "$err"). Não é um problema do código; nada foi decidido com base nessa leitura." >&2
exit 1
