# Loopkeeper backend — single-user, always-on. Built for Fly.io / Render / any container host.
FROM node:22-bookworm-slim

WORKDIR /app
# Build tools for better-sqlite3's native module (prebuilds usually cover this; kept as fallback).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

# Install deps first for layer caching.
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY pnpm-lock.yaml* ./
COPY backend/package.json ./backend/
RUN pnpm install --no-frozen-lockfile

# Build the backend (backend/tsconfig.json extends ../tsconfig.base.json, copied above).
COPY backend ./backend
RUN pnpm --filter @loopkeeper/backend build

ENV HOST=0.0.0.0 \
    PORT=8080 \
    LOOPKEEPER_DATA_DIR=/data \
    LOOPKEEPER_TZ=Asia/Kolkata
VOLUME /data
EXPOSE 8080
CMD ["node", "backend/dist/server/server.mjs"]
