# proxy/Dockerfile
#
# Build context is the repository root (pnpm workspace). Build with:
#   docker build -f proxy/Dockerfile .
# or via the root compose.yaml, which sets context/dockerfile for the
# "proxy" service.
#
# Two stages: "build" compiles the native better-sqlite3 module and installs
# only the proxy workspace project's dependencies (pnpm --filter spm-proxy...
# keeps the contracts/mcp/cli dependency trees out of this image). "runtime"
# copies the installed node_modules and proxy source into a slim image with
# no compiler toolchain, and runs as a non-root user.
#
# No build step (`tsc`) exists for the proxy package (see proxy/package.json
# "start"): it runs TypeScript directly through tsx at runtime, so tsx (a
# devDependency) stays installed in the runtime image.

ARG NODE_VERSION=22.23.2

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="${PNPM_HOME}:${PATH}"
RUN corepack enable && corepack prepare pnpm@12.5.1 --activate

FROM base AS build
# python3/make/g++: better-sqlite3's postinstall step (allowed explicitly in
# pnpm-workspace.yaml's allowBuilds) needs a compiler toolchain when no
# prebuilt binary matches this platform.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Workspace membership files only (SPEC.md 10.3; pnpm-workspace.yaml lists
# contracts, proxy, mcp, cli). `--filter spm-proxy...` then installs only
# the proxy project's own dependency tree, not the other three.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY proxy/package.json proxy/package.json
COPY contracts/package.json contracts/package.json
COPY mcp/package.json mcp/package.json
COPY cli/package.json cli/package.json
RUN pnpm install --frozen-lockfile --filter spm-proxy...
COPY proxy/src proxy/src
COPY proxy/tsconfig.json proxy/tsconfig.json
# scripts/record-review.mjs (SPEC §14) is the operator's `docker compose run`
# entry point. It imports ./network.mjs and ./review-anchor.mjs by relative
# path, and dynamically imports ../proxy/src/status.js, so scripts/ must sit
# next to proxy/ in the image with this same relative layout. Only these
# three files: not their *.test.mjs, and not scripts/anchor-review.mjs
# (the auditor's own machine, never the server).
COPY scripts/record-review.mjs scripts/record-review.mjs
COPY scripts/review-anchor.mjs scripts/review-anchor.mjs
COPY scripts/network.mjs scripts/network.mjs

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app/proxy
# Named-volume mount point for the SQLite file (compose.yaml). Created and
# chowned here so Docker copies this ownership onto the volume on first
# creation, letting the non-root "node" user write to it.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
COPY --from=build --chown=node:node /app/node_modules /app/node_modules
COPY --from=build --chown=node:node /app/proxy /app/proxy
COPY --from=build --chown=node:node /app/scripts /app/scripts
USER node
EXPOSE 4873
CMD ["node", "--import", "tsx/esm", "src/index.ts"]
