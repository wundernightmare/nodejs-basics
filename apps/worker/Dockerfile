# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# @base/worker — multi-stage production image (Kafka consumer + BullMQ worker)
#
# Build context — repo ROOT:
#   docker build -f apps/worker/Dockerfile --tag nodejs-basics-worker:dev .   ← repo root
#
# Same shape as apps/api/Dockerfile: build the whole workspace, then ship it on
# distroless Node (the @base/* symlinks resolve to their in-place dist; the
# native @confluentinc/kafka-javascript addon links libstdc++/glibc only).
#
# Runtime injection:
#   ADMIN_PORT     admin/metrics server port (default 9090)
#   VALKEY_URL     redis://valkey:6379       (BullMQ connection)
#   KAFKA_BROKERS  broker1:9092,broker2:9092
# ─────────────────────────────────────────────────────────────────────────────

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm AS builder
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /repo
COPY . .
RUN --mount=type=cache,target=/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm build

FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime

LABEL org.opencontainers.image.title="nodejs-basics-worker" \
      org.opencontainers.image.description="Kafka consumer + BullMQ worker draining tasks.events (nodejs-basics)" \
      org.opencontainers.image.vendor="tracehub" \
      org.opencontainers.image.source="https://github.com/wundernightmare/nodejs-basics" \
      org.opencontainers.image.licenses="UNLICENSED"

WORKDIR /repo/apps/worker
COPY --from=builder --chown=nonroot:nonroot /repo /repo

ENV NODE_ENV=production
# Observability admin server (metrics/livez/readyz)
EXPOSE 9090

USER nonroot
CMD ["dist/src/main.js"]
