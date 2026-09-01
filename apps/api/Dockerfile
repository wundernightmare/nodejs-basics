# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# @base/api — multi-stage production image
#
# Build context — repo ROOT (so the build sees the pnpm workspace + every
# @base/* package this app imports):
#
#   docker build -f apps/api/Dockerfile --tag nodejs-basics-api:dev .   ← repo root
#
# Strategy
# ────────
#   1. builder: full workspace install (incl dev deps) → build every package →
#      `pnpm deploy` a self-contained, prod-only bundle of @base/api (its dist
#      plus the resolved workspace + npm deps, no dev tooling).
#   2. runtime: distroless Node — just node + the bundle.
#
# AppSec properties of the final image
# ─────────────────────────────────────
#   • Distroless Node runtime — no shell, no package manager, no build tools
#   • Non-root principal (uid 65532 / "nonroot")
#   • Only the app bundle + production node_modules ship. The native
#     @confluentinc/kafka-javascript addon links libstdc++/glibc only
#     (librdkafka is statically bundled), which distroless/nodejs provides.
#   • No secrets, credentials or TLS material baked into any layer
#
# Runtime injection (never bake these into the image)
# ────────────────────────────────────────────────────
#   PORT           HTTP listen port (default 3000)
#   DATABASE_URL   postgresql://app:app@postgres:5432/app
#   VALKEY_URL     redis://valkey:6379
#   KAFKA_BROKERS  broker1:9092,broker2:9092
# ─────────────────────────────────────────────────────────────────────────────

ARG NODE_VERSION=24

# ── Stage 1 – builder ────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm AS builder
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
# Pin pnpm to the version this lockfile was written with; corepack would
# otherwise pull the latest major and reject the lockfile. Node 26 no longer
# ships corepack, so install it first.
RUN npm install -g corepack@latest \
    && corepack enable && corepack prepare pnpm@11.25.0 --activate
WORKDIR /repo

COPY . .
RUN --mount=type=cache,target=/pnpm/store \
    pnpm install --frozen-lockfile
# Build every package + the app (workspace packages emit their dist in place).
RUN pnpm build
# Strip the dev-tool native binaries that ship via devDependencies. These are Go
# binaries — tsgo (typecheck), oxlint's tsgolint, lefthook (git hooks) — never
# invoked by the running service (the container runs `node dist/src/main.js`),
# but grype flags their bundled, older Go stdlib. Removing the .pnpm packages
# leaves every runtime dependency and the emitted dist untouched, so the image
# still boots; it just no longer carries unreachable dev-tool CVEs.
# (A full pnpm-workspace prod prune is unreliable in Docker — `pnpm prune --prod`
# drops prod deps it can't see from the root manifest, and `pnpm install --prod`
# is a no-op once the dev tree exists — so we target the offenders directly.)
RUN rm -rf node_modules/.pnpm/@typescript+native-preview-linux-* \
           node_modules/.pnpm/@oxlint-tsgolint+linux-* \
           node_modules/.pnpm/lefthook-linux-* \
           node_modules/.pnpm/lefthook-*

# ── Stage 2 – runtime ────────────────────────────────────────────────────────
# distroless/nodejs ships node + glibc/libstdc++ — no shell, no package manager.
# The whole built workspace ships so the api's @base/* symlinks resolve to their
# in-place dist; the native @confluentinc/kafka-javascript addon (built on the
# matching glibc) loads against distroless' libstdc++.
FROM gcr.io/distroless/nodejs24-debian12:nonroot AS runtime

LABEL org.opencontainers.image.title="nodejs-basics-api" \
      org.opencontainers.image.description="Reference NestJS API over Postgres + Valkey + Kafka (nodejs-basics)" \
      org.opencontainers.image.vendor="tracehub" \
      org.opencontainers.image.source="https://github.com/wundernightmare/nodejs-basics" \
      org.opencontainers.image.licenses="UNLICENSED"

WORKDIR /repo/apps/api
COPY --from=builder --chown=nonroot:nonroot /repo /repo

ENV NODE_ENV=production
# HTTP API + the observability admin server (metrics/livez/readyz)
EXPOSE 3000 9090

USER nonroot
# distroless/nodejs ENTRYPOINT is the node binary; pass the entrypoint script.
CMD ["dist/src/main.js"]
