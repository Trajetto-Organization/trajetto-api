# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# ================================
# Stage: Node
# ================================
# The official image: it installs and builds the app, and lends the runtime
# its node binary. Node 22 LTS on Alpine; version pinned for reproducible
# builds.
#
# Prisma 7 has no query engine binary (queries are compiled in WebAssembly and
# sent through `@prisma/adapter-pg`), so the client runs on musl as it is. The
# Prisma CLI still downloads its schema engine (`prisma migrate deploy`) for
# the platform it detects at install time, linux-musl-openssl-3.0.x here.
#
# Pinned by digest too (INFRA-16): a tag can be re-pushed, a digest cannot.
# Dependabot (docker ecosystem) moves the tag and the digest together. The
# tag names its Alpine minor: the runtime base below must be the same one,
# because this binary is built against that minor's musl and libstdc++
# (tests/unitaires/lifecycle/image-layers.test.ts holds the two together).
FROM node:22.23.4-alpine3.23@sha256:6abbcf5dd6b231da109bcde1181db1d92bf78015ae1a9514d9807c1f857869db AS node

# ================================
# Stage: The node binary, as a reproducible tree
# ================================
# Copied straight to /usr/local/bin, the layer gets /usr, /usr/local and
# /usr/local/bin stamped with the build's time: every uncached build (a new
# runner, an evicted GitHub cache) made a new ~46 MB blob of the same binary,
# and the server pulled it again (measured 28/10/2026: three builds, three
# digests). Here the directories take the binary's own mtime, so the layer
# is a function of the Node image digest alone — the same blob in every
# build, and in every image that copies it this way.
FROM node AS node-binary

RUN mkdir -p /out/usr/local/bin \
    && cp -p /usr/local/bin/node /out/usr/local/bin/node \
    && touch -h -r /usr/local/bin/node /out/usr/local/bin /out/usr/local /out/usr

# ================================
# Stage: Runtime base (Alpine + the node binary, nothing else)
# ================================
# The container runs ./docker-entrypoint.sh and node, and the release
# migrations run the same script (`migrate`): no package manager. The runner
# used to start from the Node image and `rm -rf` its npm, corepack and yarn,
# which only hid them (the image scan flagged npm's bundled `tar`,
# CVE-2026-59873, 27/10/2026): layers are additive, so every pull still
# carried them, with the C headers. Starting from Alpine and copying the one
# binary leaves them out for real (measured 28/10/2026 on Prisma 6.1, same
# sources, with that version's prune: 417 → 285 MB unpacked, 115 → 88 MB
# compressed). On Prisma 7.10.1, whose CLI is larger, the same base with the
# prune below gives 431 MB unpacked and 114.8 MB compressed (measured
# 28/10/2026, docs/deploy.md).
FROM alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a AS base

# First, and `--link`: a layer of its own that does not depend on the
# Alpine one below, so an Alpine patch bump leaves this layer's digest as it
# was and the server does not pull it again.
COPY --link --from=node-binary /out/ /

# What the binaries here link against (ldd): node and bcrypt's musl prebuild
# need libstdc++ (libgcc comes with it); the Prisma schema engine (`prisma
# migrate deploy`) needs libssl3 and libcrypto3, and Prisma picks it by
# finding libssl.so.3 in /usr/lib, so no `openssl` binary is needed. Node
# bundles its own OpenSSL, CA store and full ICU: pt-BR dates and
# America/Sao_Paulo need no tzdata, and the server's own connections (pg,
# through @prisma/adapter-pg) use Node's TLS. The schema engine's TLS to
# Postgres reads the system CA store (ca-certificates).
# dumb-init is the ENTRYPOINT; busybox wget, the HEALTHCHECK, is Alpine's
# own. Nothing is linked against glibc (no libc6-compat) and nothing calls
# procps.
#
# The OpenSSL upgrade takes Alpine's fixes at build time without waiting for
# a new base digest (the scan once flagged libcrypto3 3.5.4 with 3.5.6 out).
RUN apk upgrade --no-cache libcrypto3 libssl3 \
    && apk add --no-cache ca-certificates dumb-init libssl3 libstdc++

RUN addgroup --gid 1001 --system nodejs \
    && adduser --uid 1001 --system --ingroup nodejs --shell /bin/sh nodejs

# ================================
# Stage: Dependencies
# ================================
FROM node AS deps

WORKDIR /app

COPY package.json yarn.lock* ./
COPY prisma/vitest-environment-prisma ./prisma/vitest-environment-prisma

# Dedicated cache id plus `sharing=locked`: this stage and `prod-deps` both
# depend only on `node`, so BuildKit runs them in parallel. With the default
# shared cache mount, two concurrent `yarn install` runs write to the same
# directory and corrupt each other's entries, failing with ENOENT on a
# `.yarn-tarball.tgz`.
RUN --mount=type=cache,target=/usr/local/share/.cache/yarn,id=yarn-dev,sharing=locked \
    yarn install --frozen-lockfile --production=false

# ================================
# Stage: Builder
# ================================
FROM node AS builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules

# The client is generated from the schema alone, BEFORE the source arrives:
# with `COPY . .` first, every source edit reran `prisma generate` in CI.
# Prisma 7 reads its settings from prisma.config.ts; with no DATABASE_URL here
# it declares no datasource, which `generate` does not need. Nothing else in
# the context reaches it — .env* is not in the build context (.dockerignore).
COPY package.json prisma.config.ts ./
COPY prisma/schema.prisma ./prisma/schema.prisma
RUN yarn prisma generate

# The generated typings (index.d.ts alone is ~7 MB) serve the editor and
# `tsc`, which run outside this build: tsup does not type-check (no `dts` in
# tsup.config.ts), and the runner copies this directory as it is.
RUN find node_modules/.prisma -name '*.d.ts' -delete

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
FROM node AS prod-deps

WORKDIR /app

COPY package.json yarn.lock* ./
COPY prisma/vitest-environment-prisma ./prisma/vitest-environment-prisma

# Separate cache id from the `deps` stage — see the note there.
RUN --mount=type=cache,target=/usr/local/share/.cache/yarn,id=yarn-prod,sharing=locked \
    yarn install --frozen-lockfile --production=true

# `yarn install` brings whole packages; what nothing loads at run time goes
# before the runner copies them (here, in a stage that is not shipped, a RUN
# of its own reclaims it — only this stage's result is copied):
# - source maps, typings and READMEs (Node reads a dependency's .map only
#   with --enable-source-maps; the API's own build has `sourcemap: false`);
# - @types (typings only, pulled in as dependencies of engine.io and
#   @fast-csv) and exceljs/dist, the package's `browser` bundle — its `main`
#   is excel.js → lib/;
# - the embedded Postgres of `prisma dev` (pglite, imported only when that
#   command runs) and the query compilers of every database: the generated
#   client in .prisma carries its own PostgreSQL one, and the CLI's serve
#   `prisma generate`, which runs in the builder. The Studio UI
#   (@prisma/studio-core) and @prisma/dev STAY: the CLI requires both when it
#   starts, and without them `migrate deploy` fails with "Cannot find module
#   '@prisma/studio-core/data/bff'" (smoke-tested).
# The Prisma paths go to `rm -r` without -f: a path that is gone fails it, and
# so does a glob that matches nothing (sh leaves it as written). If a Prisma
# bump moves pglite or renames the compilers, the build stops here instead of
# shipping them again unnoticed.
# Every dependency still loads, the CLI migrates offline, ExcelJS, PDFKit and
# bcrypt work (and the smoke test in deploy.yml runs the image).
RUN find node_modules -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -iname '*.md' -o -iname '*.markdown' \) -delete \
    && rm -rf node_modules/@types node_modules/exceljs/dist \
    && rm -r node_modules/@electric-sql/pglite \
        node_modules/@prisma/client/runtime/query_compiler_* \
        node_modules/prisma/build/query_compiler_*

# ================================
# Stage: Production Runtime
# ================================
FROM base AS runner

LABEL org.opencontainers.image.source="https://github.com/Trajetto-Organization/trajetto-api"
LABEL org.opencontainers.image.description="Trajetto API (Fastify + Prisma)"
LABEL org.opencontainers.image.licenses="LicenseRef-Trajetto-Proprietary"

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3333
ENV HOSTNAME="0.0.0.0"

# libuv's threadpool (default 4) serves bcrypt, gzip for every compressed
# response, fs and dns.lookup. bcrypt is capped at two concurrent operations
# per process (src/shared/security/bcrypt-gate.ts); eight threads leave six for
# the rest, so a login burst cannot delay DNS, gzip or file reads by seconds.
ENV UV_THREADPOOL_SIZE=8

# Most stable first: a layer that changes takes every COPY after it along,
# and each deploy re-sends what changed over the VPS's flaky route to GHCR.
# The dependencies change with yarn.lock, the generated client with the
# schema, the rest rarely; build/ changes on every commit, so it goes last
# (measured: a source-only commit re-ships that one layer, ~1 MB compressed;
# with build/ third, seven layers after it came along).
COPY --from=prod-deps --chown=nodejs:nodejs /app/node_modules ./node_modules

# The Prisma client is generated (`prisma generate`) and resides in
# node_modules/.prisma. The clean installation above does not produce it, so
# we bring the artifact from the builder. It carries its own PostgreSQL query
# compiler (query_compiler_fast_bg.*); the schema engine the CLI needs for
# `prisma migrate deploy` (docker-entrypoint.sh, also the release step) stays
# in node_modules/@prisma/engines, put there by its postinstall.
COPY --from=builder --chown=nodejs:nodejs /app/node_modules/.prisma ./node_modules/.prisma

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

COPY --from=builder --chown=nodejs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nodejs:nodejs /app/prisma ./prisma
# `prisma migrate deploy` reads the schema, the migrations and DATABASE_URL
# through this file (Prisma 7).
COPY --from=builder --chown=nodejs:nodejs /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder --chown=nodejs:nodejs /app/build/src/modules ./src/modules
COPY --from=builder --chown=nodejs:nodejs /app/build ./build

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
