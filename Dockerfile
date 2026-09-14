# syntax=docker/dockerfile:1.7

# ================================
# Stage: Base
# ================================
# Node 22 LTS on Alpine; version pinned for reproducible builds.
#
# Alpine uses musl instead of glibc, which means the `binaryTargets` in
# prisma/schema.prisma must include `linux-musl-openssl-3.0.x` — the Debian
# engine does NOT run here. Revert that along with the base image if switching.
FROM node:22.21.1-alpine AS base

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
COPY . .

RUN yarn prisma generate
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

COPY --from=prod-deps --chown=nodejs:nodejs /app/node_modules ./node_modules

# The Prisma client is generated (`prisma generate`) and resides in node_modules/.prisma.
# The clean installation above does not produce it, so we bring the artifact from the builder.
COPY --from=builder --chown=nodejs:nodejs /app/node_modules/.prisma ./node_modules/.prisma

COPY --from=builder --chown=nodejs:nodejs /app/build ./build
COPY --from=builder --chown=nodejs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nodejs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nodejs:nodejs /app/build/src/modules ./src/modules

# Excel file with traffic violation codes — read at startup by the
# `seed:infringement:production` script from the working directory.
COPY --from=builder --chown=nodejs:nodejs /app/tabela-codigo-infracoes-renainf-xlsx.xlsx ./tabela-codigo-infracoes-renainf-xlsx.xlsx

RUN mkdir -p /home/nodejs/.cache/yarn /home/nodejs/.yarn \
    && chown -R nodejs:nodejs /home/nodejs/.cache /home/nodejs/.yarn

ENV YARN_CACHE_FOLDER=/home/nodejs/.cache/yarn
ENV YARN_GLOBAL_FOLDER=/home/nodejs/.yarn

USER nodejs

EXPOSE 3333

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3333/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]

CMD ["yarn", "start"]
