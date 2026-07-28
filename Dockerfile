# Manta server image.
#
# The server runs apps/server straight from TypeScript source via Node's type
# stripping. No secrets are baked into the image — every credential arrives as an
# environment variable injected by whatever runs the container. The @manta/*
# workspace packages are consumed as
# TS source through pnpm symlinks, whose realpaths live under packages/ (outside
# node_modules), so Node strips their types too. That's why the image keeps repo
# source + node_modules rather than a standalone esbuild bundle: bundling the
# workspace packages as "external" would leave unresolved TS imports at runtime.
#
# The web SPA is built in this image and served by the server (single origin), so
# cookies/SSE/WebSocket all share one origin with no CORS.
#
# Single-stage by design for v1: pnpm's symlinked node_modules makes copying a
# pruned tree between stages fragile. Slimming to multi-stage is a later
# optimization once the deploy path is proven.
FROM node:24-slim

# node-pty compiles a native addon during install → needs python3 + a C++ toolchain.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

WORKDIR /app

ARG GIT_SHA=""
ENV MANTA_GIT_HASH=$GIT_SHA

# .dockerignore keeps node_modules / dist / .env* out of the build context, so
# this copies just the source + manifests. Install runs the repo postinstall
# (prisma generate + a darwin-only chmod that no-ops on linux).
COPY . .
RUN pnpm install --frozen-lockfile

# Build the web SPA (served statically by the server) and (re)generate the Prisma
# client against the copied schema.
RUN pnpm --filter @manta/db generate \
 && pnpm --filter @manta/web build

ENV NODE_ENV=production \
    PORT=3020 \
    WEB_ROOT=apps/web/dist \
    HOME=/home/node

EXPOSE 3020

# Run as the non-root `node` user (uid 1000, present in the base image). /app
# stays root-owned and read-only at runtime; Pi writes sessions/auth under
# $HOME (~/.pi) and Prisma's query engine uses /tmp, both writable by node.
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3020)+'/_ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-transform-types", "apps/server/src/server.ts"]
