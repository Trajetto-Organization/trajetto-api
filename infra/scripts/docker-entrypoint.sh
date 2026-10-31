#!/bin/sh
# Checks the database, then REPLACES this shell with the API process.
#
# `exec` is the point of this file. The API has to be the direct child of
# dumb-init so the SIGTERM of a deploy reaches Node and the graceful shutdown
# runs. The previous CMD, `yarn start`, ran these same steps through run-s and
# left Yarn Classic as the long-lived parent: Yarn answers SIGTERM with an
# immediate exit(1), dumb-init exits with it, and the kernel SIGKILLs Node in
# the middle of whatever it was doing — requests cut, notifications resent.
#
# Two modes, chosen by the first argument:
#
#   serve    (default) the API. It never migrates: it waits for Postgres and
#            refuses a database that lacks this build's last migration
#            (build/schema-version.json, infra/scripts/schema-guard.ts).
#   migrate  the RELEASE STEP: migrate and seed once, strictly, then exit
#            without starting the server. It runs from the
#            trajetto-api-migrate image, the only one that carries the Prisma
#            CLI (migrate/); infra/scripts/run-release-migrations.sh runs it
#            as a one-off Swarm job before the rollout, so a failing migration
#            fails ONE deploy step instead of the boot of every replica of
#            every version (P3009). See docs/deploy.md (Migrations).
set -e

MODE="${1:-serve}"

case "$MODE" in
  serve | migrate) ;;
  *)
    # A typo must not fall through to "serve" and boot the wrong process.
    echo "[entrypoint] ERRO: modo desconhecido '$MODE' (use serve ou migrate)" >&2
    exit 64
    ;;
esac

if [ "$MODE" = "migrate" ]; then
  # Where the Prisma CLI is: the release image keeps it apart, in migrate/
  # with its own node_modules and prisma.config.ts, so the API image ships
  # without it; a checkout (`yarn migrate:release`) has it in the root. The
  # API image has neither, and says which image migrates instead of failing
  # on a missing binary.
  if [ -x migrate/node_modules/.bin/prisma ]; then
    CLI_DIR=migrate
  elif [ -x node_modules/.bin/prisma ]; then
    CLI_DIR=.
  else
    echo "[entrypoint] ERRO: esta imagem não migra (não traz o CLI do Prisma). As migrations rodam com ghcr.io/trajetto-organization/trajetto-api-migrate do mesmo commit; ver docs/deploy.md (Migrations)." >&2
    exit 64
  fi

  node build/wait-for-postgres.js

  # Schema work runs on MIGRATION_DATABASE_URL when it is set. The runtime
  # DATABASE_URL carries statement_timeout and lock_timeout (.env.example),
  # and neither may apply here: a CREATE INDEX or a backfill cancelled
  # halfway is a failed migration, and lock_timeout would cut short the wait
  # on migrate's advisory lock. Only the server keeps the timed connection.
  SCHEMA_URL="${MIGRATION_DATABASE_URL:-$DATABASE_URL}"

  (cd "$CLI_DIR" && DATABASE_URL="$SCHEMA_URL" ./node_modules/.bin/prisma migrate deploy)

  # Strict: `set -e` turns a seed failure into a failed release step, which
  # is the point — the step is watched, a replica's boot log is not. Both
  # seeds are idempotent and exit 0 when there is nothing left to do.
  DATABASE_URL="$SCHEMA_URL" node build/seed.js
  DATABASE_URL="$SCHEMA_URL" node build/import-violation-codes.js

  echo "[entrypoint] migrations e seeds aplicados; o servidor não sobe neste modo"
  exit 0
fi

node build/wait-for-postgres.js --require-migrations build/schema-version.json

exec node build/server.js
