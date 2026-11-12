# bivouac task image: git + node + pnpm + official claude CLI + supervisor + fake claude (for tests)
FROM node:22-bookworm-slim
ARG CLAUDE_CODE_VERSION=latest
ARG MISE_VERSION=v2026.11.5
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates openssh-client bash tini procps jq ripgrep libatomic1 xz-utils unzip \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@10 @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && npm cache clean --force
# Screenshots: after each attempt shot.mjs opens the preview pages in headless Chromium (Debian's, with fonts) through playwright-core,
# which is only the driver (no browser download).
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/bivouac && npm install --prefix /opt/bivouac --no-audit --no-fund --omit=dev playwright-core@1.65.0 && npm cache clean --force
ENV BIVOUAC_CHROMIUM=/usr/bin/chromium
# mise installs the tool versions a repository asks for (Node, pnpm, Python, Go, Rust…) without root, into /mise, which is a
# per-project volume. The versions of a task are written to /workspace/.bivouac/mise.toml by the daemon.
RUN arch=$([ "${TARGETARCH:-amd64}" = "arm64" ] && echo arm64 || echo x64) \
    && curl -fsSL "https://github.com/jdx/mise/releases/download/${MISE_VERSION}/mise-${MISE_VERSION}-linux-${arch}" -o /usr/local/bin/mise \
    && chmod 755 /usr/local/bin/mise && mise --version \
    && mkdir -p /mise && chown node:node /mise \
    && printf 'export PATH=/mise/data/shims:$PATH\n' > /etc/profile.d/bivouac-mise.sh
ENV MISE_DATA_DIR=/mise/data MISE_CACHE_DIR=/mise/cache MISE_YES=1 \
    MISE_OVERRIDE_CONFIG_FILENAMES=/workspace/.bivouac/mise.toml MISE_TRUSTED_CONFIG_PATHS=/workspace \
    PATH=/mise/data/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
COPY supervisor.mjs /opt/bivouac/supervisor.mjs
COPY shot.mjs /opt/bivouac/shot.mjs
COPY fake-claude/claude /opt/bivouac/fake-claude
COPY fake-claude/setup-token.out /opt/bivouac/setup-token.out
# The base image already ships a non-root `node` user (uid 1000); the CLI refuses
# --dangerously-skip-permissions as root, so everything runs as that user.
RUN mkdir -p /workspace && chown node:node /workspace
USER node
ENV HOME=/home/node
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/bivouac/supervisor.mjs"]
