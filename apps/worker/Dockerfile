# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# @base/worker — multi-stage production image (Kafka consumer + BullMQ worker)
#
# Build context — repo ROOT:
#   docker build -f apps/worker/Dockerfile --tag nodejs-basics-worker:dev .   ← repo root
#
# Same shape as apps/api/Dockerfile: build the whole workspace, then ship it on
# distroless Node (the @base/* symlinks resolve to their in-place dist; the
# native addon and bundled librdkafka .so files link libstdc++/glibc only).
#
# Runtime injection:
#   ADMIN_PORT     admin/metrics server port (default 9090)
#   VALKEY_URL     redis://valkey:6379       (BullMQ connection)
#   KAFKA_BROKERS  broker1:9092,broker2:9092
# ─────────────────────────────────────────────────────────────────────────────

ARG NODE_VERSION=26.13.1
# corepack pinned like everything else (.gitlab-ci.yml COREPACK_VERSION in step).
ARG COREPACK_VERSION=0.36.0

FROM node:${NODE_VERSION}-trixie AS builder
ARG COREPACK_VERSION
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
ENV CKJS_LINKING=dynamic BUILD_LIBRDKAFKA=1 \
    npm_config_build_from_source=true npm_config_nodedir=/usr/local
WORKDIR /repo
COPY . .
# pnpm from `packageManager` in package.json — see apps/api/Dockerfile.
RUN npm install -g corepack@${COREPACK_VERSION} && corepack enable && corepack install
RUN --mount=type=cache,target=/pnpm/store \
    pnpm fetch --store-dir /pnpm/store
RUN --network=none --mount=type=cache,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --store-dir /pnpm/store
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
           node_modules/.pnpm/allure-commandline@* \
 && rm -rf node_modules/.pnpm/@confluentinc+kafka-javascript@*/node_modules/@confluentinc/kafka-javascript/deps \
 && find node_modules/.pnpm/@confluentinc+kafka-javascript@*/node_modules/@confluentinc/kafka-javascript/build \
      -type f ! -name '*.node' ! -name '*.so*' -delete
RUN bash scripts/copy-native-runtime.sh \
    node_modules/.pnpm/@confluentinc+kafka-javascript@*/node_modules/@confluentinc/kafka-javascript \
    /native-libs

FROM gcr.io/distroless/nodejs26-debian13:nonroot AS runtime

LABEL org.opencontainers.image.title="nodejs-basics-worker" \
      org.opencontainers.image.description="Kafka consumer + BullMQ worker draining tasks.events (nodejs-basics)" \
      org.opencontainers.image.vendor="wundernightmare" \
      org.opencontainers.image.source="https://github.com/wundernightmare/nodejs-basics" \
      org.opencontainers.image.licenses="UNLICENSED"

WORKDIR /repo/apps/worker
COPY --from=builder /native-libs/ /
COPY --from=builder --chown=nonroot:nonroot /repo /repo

ENV NODE_ENV=production
# The build's identity: service.version in every log line and trace, and
# GET /version. CI passes them (--build-arg); a local build is "dev".
ARG SERVICE_VERSION=dev
ARG GIT_COMMIT=unknown
ENV SERVICE_VERSION=$SERVICE_VERSION GIT_COMMIT=$GIT_COMMIT
LABEL org.opencontainers.image.version=$SERVICE_VERSION \
      org.opencontainers.image.revision=$GIT_COMMIT
# Observability admin server (metrics/livez/readyz)
EXPOSE 9090

USER nonroot
CMD ["dist/main.js"]
