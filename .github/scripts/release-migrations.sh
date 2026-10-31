#!/usr/bin/env bash
#
# The CI side of the release step: asks the Dokploy host, over SSH, to run
# the migrations once with the given release image, and streams the job's
# log into this run. The staging deploy and the promote to production call
# it (deploy.yml), each with its own environment's secrets.
#
# Usage: release-migrations.sh ghcr.io/trajetto-organization/trajetto-api-migrate@sha256:<digest>
#
# The key is restricted on the host to infra/scripts/run-release-migrations.sh
# (a forced command pinned to that environment's API service), so the image
# reference is the whole of what this sends; the host validates it and
# reuses the running API service's env — no database credential lives in CI.
# docs/deploy.md ("Migrations") has the setup.
#
# Environment: SSH_HOST, SSH_USER, SSH_KEY, SSH_KNOWN_HOSTS (the DEPLOY_SSH_*
# secrets of the environment) and ENVIRONMENT, its name, for the messages.
#
# A connection that never opened (ssh exits 255 before the host printed a
# line) is tried again, up to SSH_ATTEMPTS times: nothing ran, and a network
# blip must not fail a deploy. Once the host has answered, never: the job may
# be migrating, and a second one would race the first for Prisma's advisory
# lock. The host's own exit code passes through.
set -euo pipefail

IMAGE="${1:-}"
ENVIRONMENT="${ENVIRONMENT:-}"
ATTEMPTS="${SSH_ATTEMPTS:-3}"
RETRY_SECONDS="${SSH_RETRY_SECONDS:-15}"

if [ -z "$IMAGE" ]; then
  echo "::error::release-migrations.sh precisa da imagem de migração (trajetto-api-migrate@sha256:<digest>)."
  exit 2
fi

missing=""
[ -n "${SSH_HOST:-}" ] || missing="$missing DEPLOY_SSH_HOST"
[ -n "${SSH_USER:-}" ] || missing="$missing DEPLOY_SSH_USER"
[ -n "${SSH_KEY:-}" ] || missing="$missing DEPLOY_SSH_KEY"
[ -n "${SSH_KNOWN_HOSTS:-}" ] || missing="$missing DEPLOY_SSH_KNOWN_HOSTS"

if [ -n "$missing" ]; then
  echo "::error::Faltam os secrets${missing} no environment ${ENVIRONMENT}. A imagem da API não migra (não traz o CLI do Prisma) e não sobe num banco sem as migrations dela: o deploy precisa do job de migrations antes. Nada foi movido nem implantado. Configuração: docs/deploy.md, seção Migrations."
  exit 1
fi

dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT

(
  umask 077
  printf '%s\n' "$SSH_KEY" > "$dir/key"
  printf '%s\n' "$SSH_KNOWN_HOSTS" > "$dir/known_hosts"
)

for attempt in $(seq 1 "$ATTEMPTS"); do
  code=0
  # ServerAlive: the host's script is silent while it polls (up to 15 min),
  # and the runner's NAT drops an idle TCP flow after a few minutes — the
  # step would then hang on a session that is gone.
  ssh -i "$dir/key" -o IdentitiesOnly=yes -o BatchMode=yes \
    -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$dir/known_hosts" \
    -o ConnectTimeout=20 -o ServerAliveInterval=30 -o ServerAliveCountMax=6 \
    "$SSH_USER@$SSH_HOST" "$IMAGE" 2>&1 | tee "$dir/output" || code=$?

  if [ "$code" -eq 0 ]; then
    exit 0
  fi

  if [ "$code" -ne 255 ] || grep -q '\[release-migrations\]' "$dir/output"; then
    echo "::error::O job de migrations falhou no host (código ${code}); a saída está acima. Nada foi movido nem implantado. P3009 ou migration pela metade: docs/deploy.md, seção Migrations."
    exit "$code"
  fi

  if [ "$attempt" -ge "$ATTEMPTS" ]; then
    echo "::error::O SSH até o host do Dokploy não abriu depois de ${ATTEMPTS} tentativas (código 255; a saída do ssh está acima). Nenhuma migration rodou e nada foi movido. Não é um problema do código: confira DEPLOY_SSH_HOST e a regra da porta 22 no firewall (docs/infraestrutura.md)."
    exit 1
  fi

  echo "::warning::O SSH até o host do Dokploy não abriu (tentativa ${attempt} de ${ATTEMPTS}; nenhuma migration rodou). De novo em $((attempt * RETRY_SECONDS))s."
  sleep $((attempt * RETRY_SECONDS))
done
