#!/usr/bin/env bash
#
# The source key of the release image (trajetto-api-migrate): one hash of
# every file the release step runs or reads, as git names them in HEAD.
#
#   migrate-source.sh          the key on stdout (40 hex characters)
#   migrate-source.sh --list   the paths it hashes, one per line
#
# build-and-push tags every release image `src-<key>` and reuses the one it
# finds for the key instead of building again, as it does for the AI with
# infra/ai-ocr. The deploys run the release step only when that digest is
# not the one their database last applied, so a push that changes none of
# these files neither rebuilds the image nor runs the step again.
#
# What is listed: the migrations and the schema; the seeds, wait-for-postgres
# and every file of ours they import (tsup bundles them into the image); the
# data the seeds read; the entrypoint that chains them; and what builds the
# image (Dockerfile, the dependencies, the build config). A change to any of
# them makes a new image and runs the step once more — harmless, every part
# of it is idempotent. Anything else (the API's code) never reaches the step.
#
# The list is checked, not trusted: migrate-source.test.ts bundles the
# entry points the entrypoint runs and fails when one imports a file this
# list does not cover, or when the release stage copies one in. A listed
# path missing from HEAD fails here: a file renamed without this list would
# silently drop out of the key.
set -euo pipefail

PATHS=(
  Dockerfile
  .dockerignore
  package.json
  yarn.lock
  tsconfig.json
  tsup.config.ts
  prisma.config.ts
  prisma/schema.prisma
  prisma/migrations
  tabela-codigo-infracoes-renainf-xlsx.xlsx
  infra/database.ts
  infra/scripts/docker-entrypoint.sh
  infra/scripts/wait-for-postgres.ts
  infra/scripts/database-bootstrap-guard.ts
  infra/scripts/schema-guard.ts
  infra/scripts/seed.ts
  infra/scripts/import-violation-codes.ts
  src/shared/database
)

case "${1:-}" in
  --list)
    printf '%s\n' "${PATHS[@]}"
    exit 0
    ;;
  "") ;;
  *)
    echo "uso: migrate-source.sh [--list]" >&2
    exit 2
    ;;
esac

# "<object> <path>" per path: a file's blob or a directory's tree, so a new
# migration directory changes the key as much as an edited one.
lines=""
for path in "${PATHS[@]}"; do
  if ! object=$(git rev-parse --verify --quiet "HEAD:${path}"); then
    echo "::error::migrate-source.sh: ${path} não existe no commit. Um arquivo da etapa de release foi renomeado ou removido: atualize a lista deste script (e confira o migrate-source.test.ts)." >&2
    exit 1
  fi
  lines+="${object} ${path}"$'\n'
done

printf '%s' "$lines" | git hash-object --stdin
