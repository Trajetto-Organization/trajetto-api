# syntax=docker/dockerfile:1.7

# ================================
# Stage: Base
# ================================
# Node 22 LTS, versao fixa para o build ser reproduzivel. Ao trocar, revise o
# `binaryTargets` do prisma/schema.prisma: `debian-openssl-3.0.x` vale enquanto
# a base for Debian bookworm.
FROM node:22.21.1-slim AS base

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        openssl \
        procps \
        dumb-init \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

RUN groupadd --gid 1001 --system nodejs \
    && useradd --uid 1001 --system --gid nodejs --shell /bin/bash nodejs

# ================================
# Stage: Dependencies
# ================================
FROM base AS deps

WORKDIR /app

COPY package.json yarn.lock* ./
COPY prisma/vitest-environment-prisma ./prisma/vitest-environment-prisma

RUN --mount=type=cache,target=/usr/local/share/.cache/yarn \
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
# Instalacao limpa, so com `dependencies`. O padrao anterior era rodar
# `yarn install --production=true` POR CIMA do node_modules completo do builder,
# o que no yarn 1 nao remove de forma confiavel o que ja estava instalado — e as
# devDependencies acabavam indo para a imagem final (typescript, vitest, tsup,
# semantic-release e @octokit somam mais de 100 MB).
FROM base AS prod-deps

WORKDIR /app

COPY package.json yarn.lock* ./
COPY prisma/vitest-environment-prisma ./prisma/vitest-environment-prisma

RUN --mount=type=cache,target=/usr/local/share/.cache/yarn \
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

# O cliente do Prisma e GERADO (`prisma generate`) e vive em node_modules/.prisma.
# A instalacao limpa acima nao o produz, entao trazemos o artefato do builder.
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
