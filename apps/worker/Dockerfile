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

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm AS builder
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
# Node 26 no longer ships corepack, so install it before pinning pnpm.
RUN npm install -g corepack@latest \
    && corepack enable && corepack prepare pnpm@11.25.0 --activate
WORKDIR /repo
COPY . .
RUN --mount=type=cache,target=/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm build
# Strip the dev-tool native binaries that ship via devDependencies — Go binaries
# (tsgo, oxlint's tsgolint, lefthook) never invoked by the running worker, but
# grype flags their bundled Go stdlib. Every runtime dep + the emitted dist is
# untouched, so the image still boots. See apps/api/Dockerfile for why a full
# pnpm-workspace prune is unreliable here.
RUN rm -rf node_modules/.pnpm/@typescript+native-preview-linux-* \
           node_modules/.pnpm/@oxlint-tsgolint+linux-* \
           node_modules/.pnpm/lefthook-linux-* \
           node_modules/.pnpm/lefthook-*

FROM gcr.io/distroless/nodejs24-debian12:nonroot AS runtime

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
