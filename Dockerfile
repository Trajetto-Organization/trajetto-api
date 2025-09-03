FROM node:22.12.0-slim AS base

# Install only essential system dependencies
RUN apt-get update && apt-get install -y \
    openssl \
    procps \
    dumb-init \
    tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Create non-root user
RUN groupadd --gid 1001 --system nodejs \
    && useradd --uid 1001 --system --gid nodejs --shell /bin/bash nodejs

# ================================
# Stage: Dependencies
# ================================
FROM base AS deps

WORKDIR /app

# Copy dependency files
COPY package.json yarn.lock* ./

# Install only production dependencies
RUN yarn install --frozen-lockfile --production=false \
    && yarn cache clean

# ================================
# Stage: Builder
# ================================
FROM base AS builder

WORKDIR /app

# Copy dependencies from previous stage
COPY --from=deps /app/node_modules ./node_modules

# Copy source code and configuration files
COPY . .

# Generate Prisma Client
RUN yarn prisma generate

# Application build
RUN yarn build

# Install only production dependencies
RUN yarn install --frozen-lockfile --production=true \
    && yarn cache clean

# ================================
# Stage: Production Runtime
# ================================
FROM base AS runner

WORKDIR /app

# Define production environment
ENV NODE_ENV=production
ENV PORT=3333
ENV HOSTNAME="0.0.0.0"
ENV TZ=America/Sao_Paulo

# Copy files needed for production
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/build ./build
COPY --from=builder --chown=nodejs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nodejs:nodejs /app/prisma ./prisma

# Copy email templates and other assets
COPY --from=builder --chown=nodejs:nodejs /app/build/src/modules ./src/modules

# Copy infra directory
COPY --from=builder --chown=nodejs:nodejs /app/infra ./infra

# COPY EXCEL FILE FOR VIOLATIONS IMPORT
COPY --from=builder --chown=nodejs:nodejs /app/tabela-codigo-infracoes-renainf-xlsx.xlsx ./tabela-codigo-infracoes-renainf-xlsx.xlsx

# Create yarn cache and config directories with correct permissions
RUN mkdir -p /home/nodejs/.cache/yarn /home/nodejs/.yarn \
    && chown -R nodejs:nodejs /home/nodejs/.cache /home/nodejs/.yarn

# Configure Yarn to use the correct directories
ENV YARN_CACHE_FOLDER=/home/nodejs/.cache/yarn
ENV YARN_GLOBAL_FOLDER=/home/nodejs/.yarn

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3333

ENV PORT=3333
ENV HOSTNAME="0.0.0.0"

# Use dumb-init as PID 1
ENTRYPOINT ["dumb-init", "--"]

# Command to start the application
CMD ["yarn", "start"]