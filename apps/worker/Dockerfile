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
# corepack pinned like everything else (.gitlab-ci.yml COREPACK_VERSION in step).
ARG COREPACK_VERSION=0.36.0

FROM node:${NODE_VERSION}-trixie AS builder
ARG COREPACK_VERSION
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /repo
COPY . .
# pnpm from `packageManager` in package.json — see apps/api/Dockerfile.
RUN npm install -g corepack@${COREPACK_VERSION} && corepack enable && corepack install
RUN --mount=type=cache,target=/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm build
# Strip the dev tools that ship via devDependencies — Go binaries (TypeScript
# 7's tsc, oxlint's tsgolint, lefthook) and allure-commandline's jars — never
# invoked by the running worker, but grype flags their bundled deps. Every runtime dep + the emitted dist is
# untouched, so the image still boots. See apps/api/Dockerfile for why a full
# pnpm-workspace prune is unreliable here.
RUN rm -rf node_modules/.pnpm/@oxlint-tsgolint+linux-* \
           node_modules/.pnpm/@typescript+typescript-linux-* \
           node_modules/.pnpm/lefthook-linux-* \
           node_modules/.pnpm/lefthook-* \
           node_modules/.pnpm/allure-commandline@*

FROM gcr.io/distroless/nodejs24-debian13:nonroot AS runtime

LABEL org.opencontainers.image.title="nodejs-basics-worker" \
      org.opencontainers.image.description="Kafka consumer + BullMQ worker draining tasks.events (nodejs-basics)" \
      org.opencontainers.image.vendor="wundernightmare" \
      org.opencontainers.image.source="https://github.com/wundernightmare/nodejs-basics" \
      org.opencontainers.image.licenses="UNLICENSED"

WORKDIR /repo/apps/worker
COPY --from=builder --chown=nonroot:nonroot /repo /repo

ENV NODE_ENV=production
# Observability admin server (metrics/livez/readyz)
EXPOSE 9090

USER nonroot
CMD ["dist/main.js"]
