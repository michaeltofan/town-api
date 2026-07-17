# TOWN API — Deployment Readiness V1 container image.
#
# Multi-stage build produces a small runtime image with:
#   * Node.js 24 (matches .nvmrc and package.json engines).
#   * Only production dependencies (`npm ci --omit=dev`).
#   * Compiled `dist/` output.
#   * Migrations shipped for readiness (drizzle/) but NOT executed at container
#     start. Deployments must invoke `npm run db:migrate` from a controlled
#     release step (advisory-locked in scripts/db-migrate.ts).
#   * Non-root runtime user.
#
# NOTE: This Dockerfile alone does not configure any specific platform. It is
# runtime-agnostic; the deployment platform is responsible for injecting the
# required environment variables listed in `.env.example`.

# ---------- Stage 1: dependencies ----------
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# ---------- Stage 2: build ----------
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY drizzle ./drizzle
COPY scripts ./scripts
RUN npm run build

# ---------- Stage 3: production dependencies only ----------
FROM node:24-bookworm-slim AS runtime-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

# ---------- Stage 4: runtime ----------
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0
WORKDIR /app

RUN groupadd --system --gid 1001 town \
    && useradd --system --uid 1001 --gid town --home /app --shell /usr/sbin/nologin town

COPY --from=runtime-deps --chown=town:town /app/node_modules ./node_modules
COPY --from=build --chown=town:town /app/dist ./dist
COPY --chown=town:town drizzle ./drizzle
COPY --chown=town:town package.json ./package.json

USER town
EXPOSE 3000
CMD ["node", "dist/server.js"]
