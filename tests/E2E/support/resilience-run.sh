#!/usr/bin/env bash
#
# Runs the resilience E2E files against the package's OWN disposable
# containers, so the cases that stop and start Postgres and Redis mid-flow
# (contract §11, cases C and D) can run without touching anything shared:
#
#   trajetto-resil-pg     postgres:16-alpine   127.0.0.1:54322
#   trajetto-resil-redis  redis:7-alpine       127.0.0.1:63791
#
# Usage (from trajetto-api):
#   bash tests/E2E/support/resilience-run.sh tests/E2E/resilience-database-loss.test.ts ...
#
# The containers are created on demand with a random password (read back from
# the container, never printed) and REMOVED at the end, unless
# RESILIENCE_KEEP=1. Never the shared trajetto-itest-pg / trajetto-test-redis,
# never the user's trajetto-database / trajetto-redis.
set -uo pipefail

PG=trajetto-resil-pg
REDIS=trajetto-resil-redis
LABEL=trajetto.purpose=resilience-tests

cd "$(dirname "$0")/../../.."

exists() { docker inspect "$1" >/dev/null 2>&1; }

if ! exists "$PG"; then
  PW="$(node -e "console.log(require('crypto').randomBytes(18).toString('hex'))")"
  docker run -d --name "$PG" --label "$LABEL" \
    -e POSTGRES_USER=trajetto -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB=trajetto-database \
    -p 127.0.0.1:54322:5432 postgres:16-alpine >/dev/null || exit 2
fi

if ! exists "$REDIS"; then
  docker run -d --name "$REDIS" --label "$LABEL" -p 127.0.0.1:63791:6379 redis:7-alpine >/dev/null || exit 2
fi

docker start "$PG" "$REDIS" >/dev/null

for _ in $(seq 1 120); do
  docker exec "$PG" pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1 && break
  sleep 0.5
done

PW="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$PG" | sed -n 's/^POSTGRES_PASSWORD=//p')"

# 127.0.0.1, never "localhost": the ports are published on IPv4 only, and on
# Windows a refused connect to ::1 is retried for ~2 s, longer than the
# readiness probe's own 3 s connect budget allows for the fallback.
export DATABASE_URL="postgresql://trajetto:${PW}@127.0.0.1:54322/trajetto-database?schema=public"
export REDIS_URL="redis://127.0.0.1:63791"
export REDIS_HOST="127.0.0.1" REDIS_PORT="63791"
export RESILIENCE_DOCKER=1

# One file at a time: a file that stops Postgres or Redis takes them away
# from every other file running against the same containers.
timeout 1500 npx vitest run --config vite.config.mts --no-file-parallelism "$@"
STATUS=$?

# -v: both images declare a VOLUME, so each run left two anonymous volumes
# behind (the Postgres data dir and Redis' /data) that nothing ever reused.
if [ "${RESILIENCE_KEEP:-0}" != "1" ]; then
  docker rm -f -v "$PG" "$REDIS" >/dev/null 2>&1
fi

exit $STATUS
