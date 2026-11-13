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
# which is only the driver (no browser download); the single copy ships with @playwright/mcp below and is linked here.
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/bivouac/node_modules
ENV BIVOUAC_CHROMIUM=/usr/bin/chromium
# MCP servers handed to the agent (pinned): Playwright MCP drives the Chromium above, Context7 serves library documentation.
# After the install: no @types, only the OpenTelemetry API that Context7 imports at start (its exporters load only when the embedded
# Prometheus endpoint is on), no source maps, type declarations or readmes (licence files stay), and one playwright-core for everyone.
ARG PLAYWRIGHT_MCP_VERSION=0.0.85
ARG CONTEXT7_MCP_VERSION=4.7.0
RUN mkdir -p /opt/bivouac/mcp && npm install --prefix /opt/bivouac/mcp --no-audit --no-fund --omit=dev @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} @upstash/context7-mcp@${CONTEXT7_MCP_VERSION} \
    && cd /opt/bivouac/mcp/node_modules && rm -rf @types && find @opentelemetry -mindepth 1 -maxdepth 1 ! -name api -exec rm -rf {} + \
    && find . -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -iname 'README*' -o -iname 'CHANGELOG*' -o -iname 'HISTORY*' \) -delete \
    && ln -s ../mcp/node_modules/playwright-core /opt/bivouac/node_modules/playwright-core \
    && node -e "require('/opt/bivouac/node_modules/playwright-core')" && npm cache clean --force
# Skills for the agent (Apache-2.0, licence files kept next to each skill), pinned to a commit of github.com/anthropics/skills.
ARG ANTHROPIC_SKILLS_COMMIT=2c5958ecac7cee2b583967a2c4981d0f4a75c579
RUN git init -q /tmp/anthropic-skills && cd /tmp/anthropic-skills \
    && git fetch -q --depth 1 https://github.com/anthropics/skills ${ANTHROPIC_SKILLS_COMMIT} && git checkout -q FETCH_HEAD \
    && mkdir -p /home/node/.claude/skills && cp -r skills/frontend-design skills/webapp-testing /home/node/.claude/skills/ \
    && chown -R node:node /home/node/.claude && rm -rf /tmp/anthropic-skills
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
