# bivouac task image: git + node + pnpm + official claude CLI + supervisor + fake claude (for tests)
FROM node:22-bookworm-slim
ARG CLAUDE_CODE_VERSION=latest
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates openssh-client bash tini procps jq ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@10 @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && npm cache clean --force
COPY supervisor.mjs /opt/bivouac/supervisor.mjs
COPY fake-claude/claude /opt/bivouac/fake-claude
# The base image already ships a non-root `node` user (uid 1000); the CLI refuses
# --dangerously-skip-permissions as root, so everything runs as that user.
RUN mkdir -p /workspace && chown node:node /workspace
USER node
ENV HOME=/home/node
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/bivouac/supervisor.mjs"]
