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
#   1. builder: full workspace install (incl dev deps) → `pnpm build` (tsc for
#      the packages, Vite for the app bundle dist/main.js).
#   2. runtime: distroless Node (Debian 13) + the built workspace — the bundle
#      imports its externals by path relative to dist/, so the tree ships whole.
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
FROM node:${NODE_VERSION}-trixie AS builder
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /repo
COPY . .
# pnpm comes from `packageManager` in package.json (corepack reads it), so the
# image, CI and local installs cannot drift. A current corepack first: the one
# bundled with Node lags behind the npm registry's signing keys.
RUN npm install -g corepack@latest && corepack enable && corepack install
RUN --mount=type=cache,target=/pnpm/store \
    pnpm install --frozen-lockfile
# Build every package + the app (workspace packages emit their dist in place).
RUN pnpm build
# Strip the dev tools that ship via devDependencies: Go binaries — tsc
# (TypeScript 7 is native), oxlint's tsgolint, lefthook (git hooks) — and
# allure-commandline's Java jars. The running service (`node dist/main.js`)
# never invokes them, but grype flags their bundled Go stdlib / jar deps. Removing the .pnpm packages
# leaves every runtime dependency and the emitted dist untouched, so the image
# still boots; it just no longer carries unreachable dev-tool CVEs.
# (A full pnpm-workspace prod prune is unreliable in Docker — `pnpm prune --prod`
# drops prod deps it can't see from the root manifest, and `pnpm install --prod`
# is a no-op once the dev tree exists — so we target the offenders directly.)
RUN rm -rf node_modules/.pnpm/@oxlint-tsgolint+linux-* \
           node_modules/.pnpm/@typescript+typescript-linux-* \
           node_modules/.pnpm/lefthook-linux-* \
           node_modules/.pnpm/lefthook-* \
           node_modules/.pnpm/allure-commandline@*

# ── Stage 2 – runtime ────────────────────────────────────────────────────────
# distroless/nodejs ships node + glibc/libstdc++ — no shell, no package manager.
# The whole built workspace ships so the api's @base/* symlinks resolve to their
# in-place dist; the native @confluentinc/kafka-javascript addon (built on the
# matching glibc) loads against distroless' libstdc++.
FROM gcr.io/distroless/nodejs24-debian13:nonroot AS runtime

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
CMD ["dist/main.js"]
