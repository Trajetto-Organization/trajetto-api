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
# Three modes, chosen by the first argument:
#
#   serve    (default) the API. It never migrates: it waits for Postgres and
#            refuses a database that lacks any migration of this build
#            (build/schema-version.json, infra/scripts/schema-guard.ts).
#   migrate  the RELEASE STEP: migrate and seed once, strictly, then exit
#            without starting the server. It runs from the
#            trajetto-api-migrate image, the only one that carries the Prisma
#            CLI (migrate/), so a failing migration fails ONE deploy step
#            instead of the boot of every replica of every version (P3009).
#            See docs/deploy.md (Migrations).
#   release  the same step, as the Dokploy Application trajetto-api-migrate
#            runs it (the release image's default command): migrate and seed,
#            then mark the step done and stay idle. A Swarm service has to
#            keep running to report success, so the marker is what the
#            image's HEALTHCHECK waits for: Swarm shows the task `Starting`
#            while it migrates, `Running` once both steps finished and
#            `Failed` when either one failed — what
#            .github/scripts/dokploy-release.mjs reads.
set -e

MODE="${1:-serve}"

# The release step's "done", for the release image's HEALTHCHECK (Dockerfile).
RELEASE_MARKER=/tmp/trajetto-release-done

case "$MODE" in
  serve | migrate | release) ;;
  *)
    # A typo must not fall through to "serve" and boot the wrong process.
    echo "[entrypoint] ERRO: modo desconhecido '$MODE' (use serve, migrate ou release)" >&2
    exit 64
    ;;
esac

if [ "$MODE" = "migrate" ] || [ "$MODE" = "release" ]; then
  # A marker left by an earlier run of this same container (a `docker
  # start` by hand; Swarm always makes a new one) must not report this run
  # as done.
  if [ "$MODE" = "release" ]; then
    rm -f "$RELEASE_MARKER"
  fi

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

  if [ "$MODE" = "migrate" ]; then
    exit 0
  fi

  # Idle under dumb-init until the next deploy replaces this task: SIGTERM
  # reaches `tail`, which exits at once. Nothing else runs here.
  touch "$RELEASE_MARKER"
  echo "[entrypoint] etapa de release concluída; o contêiner fica parado até o próximo deploy"
  exec tail -f /dev/null
fi

node build/wait-for-postgres.js --require-migrations build/schema-version.json

exec node build/server.js
