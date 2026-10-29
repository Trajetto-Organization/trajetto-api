#!/bin/sh
# Prepares the database, then REPLACES this shell with the API process.
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
#   serve    (default) the API. While RUN_MIGRATIONS_ON_BOOT is true (the
#            default, as before) it also migrates on boot.
#   migrate  the RELEASE STEP: migrate and seed once, strictly, then exit
#            without starting the server. infra/scripts/run-release-migrations.sh
#            runs it as a one-off Swarm job before the rollout, so a failing
#            migration fails ONE deploy step instead of the boot of every
#            replica of every version (P3009). See docs/deploy.md (Migrations).
set -e

MODE="${1:-serve}"

case "$MODE" in
  serve | migrate) ;;
  *)
    # A typo must not fall through to "serve" and migrate a database nobody
    # meant to touch.
    echo "[entrypoint] ERRO: modo desconhecido '$MODE' (use serve ou migrate)" >&2
    exit 64
    ;;
esac

node build/wait-for-postgres.js

# Schema work runs on MIGRATION_DATABASE_URL when it is set. The runtime
# DATABASE_URL carries statement_timeout and lock_timeout (.env.example), and
# neither may apply here: a CREATE INDEX or a backfill cancelled halfway is a
# failed migration, and lock_timeout would cut short the wait on migrate's
# advisory lock while another replica holds it during a start-first rollout.
# Only the server below keeps the timed connection.
SCHEMA_URL="${MIGRATION_DATABASE_URL:-$DATABASE_URL}"

if [ "$MODE" = "migrate" ]; then
  DATABASE_URL="$SCHEMA_URL" ./node_modules/.bin/prisma migrate deploy

  # Strict: `set -e` turns a seed failure into a failed release step, which is
  # the point — the step is watched, a replica's boot log is not. Both seeds
  # are idempotent and exit 0 when there is nothing left to do.
  DATABASE_URL="$SCHEMA_URL" node build/seed.js
  DATABASE_URL="$SCHEMA_URL" node build/import-violation-codes.js

  echo "[entrypoint] migrations e seeds aplicados; o servidor não sobe neste modo"
  exit 0
fi

# On by default, as before. Turn it off once the deploy runs the release step
# above: a failing migration then fails the deploy once, instead of failing
# the boot of every replica.
if [ "${RUN_MIGRATIONS_ON_BOOT:-true}" = "true" ]; then
  DATABASE_URL="$SCHEMA_URL" ./node_modules/.bin/prisma migrate deploy

  # Reference data, idempotent. On boot a failure does not block the replica
  # (the release step is where seeds fail for real), but it is reported as
  # the error it is, on stderr — never as a line that reads like success.
  DATABASE_URL="$SCHEMA_URL" node build/seed.js \
    || echo "[entrypoint] ERRO: o seed falhou (exit $?); o usuário master pode não existir" >&2
  DATABASE_URL="$SCHEMA_URL" node build/import-violation-codes.js \
    || echo "[entrypoint] ERRO: a importação da tabela de infrações falhou (exit $?)" >&2
fi

exec node build/server.js
