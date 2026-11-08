# bivouac daemon image, used for both services: `web` (default command) and `executor`. Build context: repository root.
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
COPY uninstall.sh apply.sh ./
RUN pnpm -r build && CI=true pnpm install --frozen-lockfile --prod

FROM node:22-bookworm-slim
ARG VERSION=dev
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production BIVOUAC_VERSION=${VERSION} BIVOUAC_DASHBOARD_DIR=/app/packages/dashboard/dist
EXPOSE 3000
# web: node packages/daemon/dist/index.js (non-root)   executor: node packages/daemon/dist/executor-main.js (needs the Docker socket)
# cli: node packages/daemon/dist/cli.js
CMD ["node", "packages/daemon/dist/index.js"]
