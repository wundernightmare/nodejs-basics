# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# @base/migrate — the schema migration image
#
#   docker build -f apps/migrate/Dockerfile --tag nodejs-basics-migrate:dev .   ← repo root
#   docker run --rm -e DATABASE_URL=postgresql://… nodejs-basics-migrate:dev
#
# Unlike the service images it carries no node_modules and no workspace: the
# app is one self-contained bundle (pg inlined, see apps/migrate/vite.config.ts)
# plus the SQL files, on distroless Node. Run it as a Kubernetes Job / init
# container, or as the compose service the api waits for (docker/stack.yml).
#
# Runtime injection:
#   DATABASE_URL   postgresql://user:pass@host:5432/db
# ─────────────────────────────────────────────────────────────────────────────

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-trixie AS builder
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /repo
COPY . .
# pnpm from `packageManager` in package.json — see apps/api/Dockerfile.
RUN npm install -g corepack@latest && corepack enable && corepack install
RUN --mount=type=cache,target=/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm --filter @base/migrate build

FROM gcr.io/distroless/nodejs24-debian13:nonroot AS runtime

LABEL org.opencontainers.image.title="nodejs-basics-migrate" \
      org.opencontainers.image.description="Forward-only SQL migrations for nodejs-basics" \
      org.opencontainers.image.vendor="wundernightmare" \
      org.opencontainers.image.source="https://github.com/wundernightmare/nodejs-basics" \
      org.opencontainers.image.licenses="UNLICENSED"

COPY --from=builder /repo/apps/migrate/dist/main.js /app/migrate.js
COPY --from=builder /repo/migrations /migrations
ENV MIGRATIONS_DIR=/migrations
USER nonroot
CMD ["/app/migrate.js"]
