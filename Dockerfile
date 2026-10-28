# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# ================================
# Stage: Base
# ================================
# Node 22 LTS on Alpine; version pinned for reproducible builds.
#
# Alpine uses musl instead of glibc, which means the `binaryTargets` in
# prisma/schema.prisma must include `linux-musl-openssl-3.0.x` — the Debian
# engine does NOT run here. Revert that along with the base image if switching.
#
# Pinned by digest too (INFRA-16): a tag can be re-pushed, a digest cannot.
# Dependabot (docker ecosystem) moves the tag and the digest together.
FROM node:22.21.1-alpine@sha256:0340fa682d72068edf603c305bfbc10e23219fb0e40df58d9ea4d6f33a9798bf AS base

RUN apk add --no-cache \
    openssl \
    procps \
    dumb-init \
    ca-certificates \
    # Prisma loads the engine dynamically and expects glibc symbols
    # to be available via the compatibility layer.
    libc6-compat

RUN addgroup --gid 1001 --system nodejs \
    && adduser --uid 1001 --system --ingroup nodejs --shell /bin/sh nodejs

# ================================
# Stage: Dependencies
# ================================
FROM base AS deps

WORKDIR /app

COPY package.json yarn.lock* ./
COPY prisma/vitest-environment-prisma ./prisma/vitest-environment-prisma

# Dedicated cache id plus `sharing=locked`: this stage and `prod-deps` both
# depend only on `base`, so BuildKit runs them in parallel. With the default
# shared cache mount, two concurrent `yarn install` runs write to the same
# directory and corrupt each other's entries, failing with ENOENT on a
# `.yarn-tarball.tgz`.
RUN --mount=type=cache,target=/usr/local/share/.cache/yarn,id=yarn-dev,sharing=locked \
    yarn install --frozen-lockfile --production=false

# ================================
# Stage: Builder
# ================================
FROM base AS builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules

# The client is generated from the schema alone, BEFORE the source arrives:
# with `COPY . .` first, every source edit reran `prisma generate` (and its
# engine download) in CI. Nothing else in the context reaches it — .env* is
# not in the build context (.dockerignore) — so the output is the same.
COPY package.json ./
COPY prisma/schema.prisma ./prisma/schema.prisma
RUN yarn prisma generate

COPY . .

RUN yarn build

# ================================
# Stage: Production dependencies
# ================================
# Clean installation, including only `dependencies`. The previous approach
# involved running `yarn install --production=true` ON TOP of the builder's
# full `node_modules` directory; however, Yarn 1 does not reliably remove
# previously installed packages—meaning `devDependencies` would end up in
# the final image (typescript, vitest, tsup, semantic-release, and @octokit
# total over 100 MB).
FROM base AS prod-deps

WORKDIR /app

COPY package.json yarn.lock* ./
COPY prisma/vitest-environment-prisma ./prisma/vitest-environment-prisma

# Separate cache id from the `deps` stage — see the note there.
RUN --mount=type=cache,target=/usr/local/share/.cache/yarn,id=yarn-prod,sharing=locked \
    yarn install --frozen-lockfile --production=true

# ================================
# Stage: Production Runtime
# ================================
FROM base AS runner

LABEL org.opencontainers.image.source="https://github.com/Trajetto-Organization/trajetto-api"
LABEL org.opencontainers.image.description="Trajetto API (Fastify + Prisma)"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3333
ENV HOSTNAME="0.0.0.0"

# libuv's threadpool (default 4) serves bcrypt, gzip for every compressed
# response, fs and dns.lookup. bcrypt is capped at two concurrent operations
# per process (src/shared/security/bcrypt-gate.ts); eight threads leave six for
# the rest, so a login burst cannot delay DNS, gzip or file reads by seconds.
ENV UV_THREADPOOL_SIZE=8

COPY --from=prod-deps --chown=nodejs:nodejs /app/node_modules ./node_modules

# The Prisma client is generated (`prisma generate`) and resides in node_modules/.prisma.
# The clean installation above does not produce it, so we bring the artifact from the builder.
#
# The musl query engine (~16 MB) is in the image twice, and both copies are
# used: this one by @prisma/client at run time, and the one @prisma/engines'
# postinstall put in node_modules/@prisma/engines by the Prisma CLI — `prisma
# migrate deploy` (docker-entrypoint.sh, also the release step) checks that
# the query and schema engines exist there and DOWNLOADS what is missing.
# Removing that copy would turn every migration into a fetch from
# binaries.prisma.sh, or a failure with no network. node_modules/prisma has
# no engine here: only `prisma generate` writes one there, and it runs in
# the builder, whose node_modules this stage does not copy.
COPY --from=builder --chown=nodejs:nodejs /app/node_modules/.prisma ./node_modules/.prisma

COPY --from=builder --chown=nodejs:nodejs /app/build ./build
COPY --from=builder --chown=nodejs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nodejs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nodejs:nodejs /app/build/src/modules ./src/modules

# Excel file with traffic violation codes — read by build/import-violation-codes.js
# (docker-entrypoint.sh, on boot or in the `migrate` release step) from the
# working directory.
COPY --from=builder --chown=nodejs:nodejs /app/tabela-codigo-infracoes-renainf-xlsx.xlsx ./tabela-codigo-infracoes-renainf-xlsx.xlsx

# The boot script. Line endings are normalised here because a Windows
# checkout (core.autocrlf) hands it over with CRLF, and `/bin/sh\r` is not an
# interpreter. infra/ is not in the image, so package.json's `start` and
# `migrate:release` fall back to this copy.
COPY --from=builder --chown=nodejs:nodejs /app/infra/scripts/docker-entrypoint.sh ./docker-entrypoint.sh
RUN sed -i "s/\r$//" ./docker-entrypoint.sh && chmod +x ./docker-entrypoint.sh

# No package manager at run time: the container starts with
# ./docker-entrypoint.sh and node, and the release migrations run the same
# script (`migrate`). The Node image ships npm, corepack and yarn, and the
# image scan flagged npm's bundled `tar` (CVE-2026-59873, 27/10/2026); they
# are code nothing here needs, so they leave the image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /opt/yarn-v* /usr/local/bin/yarn /usr/local/bin/yarnpkg

# The commit this image was built from (deploy.yml passes GIT_SHA), which
# GET /health/liveness answers as `version`/`commit` (src/shared/build-info.ts)
# so the pipeline can tell, from outside, that the new build is the one
# serving. After the last RUN on purpose: a build arg in scope of a RUN is in
# its cache key, and every commit would rebuild that layer. It changes the
# image config only. Empty in a local build ("dev").
ARG GIT_SHA=""
ENV APP_COMMIT_SHA=${GIT_SHA}

USER nodejs

EXPOSE 3333

# Liveness, matching the API Application's healthcheck in Dokploy (Swarm
# settings, docs/deploy.md). A probe that decides whether to DESTROY the
# container must not depend on Postgres: /health answers 503 when the
# database is down, which turned a blip into a restart loop. The image
# default matters on its own because anything running it without that
# setting — a debug run, a one-off task, another orchestrator — inherits this
# and used to get the more aggressive `/health` with retries=3.
# busybox wget rather than `node -e`: measured in this base image, ~1 MB and
# ~1 ms per probe against ~52 MB and ~54 ms for a Node process, inside the
# container's memory limit. 127.0.0.1: busybox tries only the first address.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:3333/health/liveness

ENTRYPOINT ["dumb-init", "--"]

# Node, not Yarn, as the long-lived process: the script prepares the database
# and then `exec`s the server, so dumb-init delivers SIGTERM straight to it and
# the graceful shutdown in src/server.ts actually runs. See the script.
CMD ["./docker-entrypoint.sh"]
