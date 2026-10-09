#!/usr/bin/env bash
# Disposable S3-compatible storage for the upload E2E (TEST-UP-1).
#
#   bash tests/support/minio/minio-test.sh start   # creates/starts trajetto-test-minio on :59000
#   bash tests/support/minio/minio-test.sh env     # prints the exports the E2E reads
#   bash tests/support/minio/minio-test.sh stop    # stops it
#   bash tests/support/minio/minio-test.sh rm      # removes it
#
# The image is Chainguard's MinIO build: MinIO no longer publishes images on
# Docker Hub. The credentials are generated per container and read back from
# it, never printed by `start`. The data lives in a tmpfs (the image runs as a
# non-root user that cannot write its own filesystem): nothing outlives the
# container, which is what a test bucket should do.
set -euo pipefail

# Git Bash on Windows rewrites `/data` into a Windows path otherwise.
export MSYS_NO_PATHCONV=1

NAME=trajetto-test-minio
IMAGE=${MINIO_TEST_IMAGE:-cgr.dev/chainguard/minio:latest}
PORT=${MINIO_TEST_PORT:-59000}

secret_of() {
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$NAME" | sed -n "s/^$1=//p"
}

case "${1:-start}" in
  start)
    if ! docker inspect "$NAME" >/dev/null 2>&1; then
      user="trajetto$(od -An -N4 -tx4 /dev/urandom | tr -d ' ')"
      pass="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
      docker run -d --name "$NAME" -p "$PORT:9000" \
        -e MINIO_ROOT_USER="$user" -e MINIO_ROOT_PASSWORD="$pass" \
        --tmpfs /data:rw,mode=1777 \
        "$IMAGE" server /data >/dev/null
    else
      docker start "$NAME" >/dev/null
    fi
    for _ in $(seq 1 30); do
      if curl -fsS "http://localhost:$PORT/minio/health/ready" >/dev/null 2>&1; then
        echo "$NAME ready on :$PORT"
        exit 0
      fi
      sleep 1
    done
    echo "$NAME did not become ready" >&2
    exit 1
    ;;
  env)
    echo "export MINIO_TEST_ENDPOINT=http://localhost:$PORT"
    echo "export MINIO_TEST_ACCESS_KEY=$(secret_of MINIO_ROOT_USER)"
    echo "export MINIO_TEST_SECRET_KEY=$(secret_of MINIO_ROOT_PASSWORD)"
    ;;
  stop) docker stop "$NAME" >/dev/null && echo "$NAME stopped" ;;
  rm) docker rm -f "$NAME" >/dev/null && echo "$NAME removed" ;;
  *) echo "usage: $0 start|env|stop|rm" >&2; exit 2 ;;
esac
