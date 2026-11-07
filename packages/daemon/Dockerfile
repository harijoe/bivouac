# bivouac daemon image: API + dashboard (static) + SQLite. Build context: repository root.
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@10
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/daemon/package.json packages/daemon/
COPY packages/dashboard/package.json packages/dashboard/
COPY packages/task-image/ packages/task-image/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY uninstall.sh uninstall.sh
RUN pnpm -r build && CI=true pnpm install --frozen-lockfile --prod

FROM node:22-bookworm-slim
ARG VERSION=dev
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production BIVOUAC_VERSION=${VERSION} BIVOUAC_DASHBOARD_DIR=/app/packages/dashboard/dist
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 CMD curl -fsS http://127.0.0.1:${BIVOUAC_PORT:-3000}/api/health || exit 1
CMD ["node", "packages/daemon/dist/index.js"]
