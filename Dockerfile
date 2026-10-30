# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM oven/bun:1.4.4-slim AS builder
WORKDIR /app

# Copy manifests first so dependency install is cached when only source changes
COPY package.json bun.lock* tsconfig.json ./
COPY patches/ patches/
COPY packages/agent-runtime/package.json packages/agent-runtime/
COPY packages/api/package.json            packages/api/
COPY packages/channels/package.json       packages/channels/
COPY packages/cli/package.json            packages/cli/
COPY packages/core/package.json           packages/core/
COPY packages/db/package.json             packages/db/
COPY packages/gateway/package.json        packages/gateway/
COPY packages/knowledge/package.json      packages/knowledge/
COPY packages/mcp/package.json            packages/mcp/
COPY packages/runner/package.json         packages/runner/
COPY packages/sdk/package.json            packages/sdk/
COPY packages/task-service/package.json   packages/task-service/
COPY packages/web/package.json            packages/web/

RUN bun install --frozen-lockfile

# Copy source and build the web dashboard (embedded into CLI/server)
COPY packages/ packages/
COPY skills/ skills/

RUN bun run --filter @orc/web build && \
    cd packages/cli && bun run build:copy-web

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS agent-tools
ARG ACPX_VERSION=0.21.1
ARG CODEX_VERSION=0.164.0
ARG CLAUDE_CODE_VERSION=2.1.311
RUN npm install --prefix /opt/orc-tools --omit=dev \
    acpx@${ACPX_VERSION} @openai/codex@${CODEX_VERSION} @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

FROM oven/bun:1.4.4-slim AS runner
WORKDIR /app

# The Bun base image provides the unprivileged `bun` user (UID 1000), which
# keeps mounted SSH credentials and persistent data readable when they belong
# to the host user.

# Minimal runtime OS packages — tini for correct signal forwarding + PID 1
RUN apt-get update && apt-get install -y --no-install-recommends tini curl git openssh-client ripgrep ca-certificates libstdc++6
COPY --from=agent-tools /usr/local/bin/node /usr/local/bin/node
COPY --from=agent-tools /opt/orc-tools /opt/orc-tools
ENV PATH="/opt/orc-tools/node_modules/.bin:${PATH}"
RUN node --version && acpx --version && codex --version && claude --version

# Copy only the runtime artifacts from the builder
COPY --from=builder --chown=bun:bun /app/node_modules   ./node_modules
COPY --from=builder --chown=bun:bun /app/packages        ./packages
COPY --from=builder --chown=bun:bun /app/skills          ./skills
COPY --from=builder --chown=bun:bun /app/package.json    ./

# Persistent data dir (SQLite DB, logs). Mount a named volume here.
RUN mkdir -p /data && chown bun:bun /data

COPY docker-entrypoint.sh /usr/local/bin/orc-entrypoint
RUN chmod 755 /usr/local/bin/orc-entrypoint && \
    TINI_SUBREAPER=1 /usr/local/bin/orc-entrypoint true

# ── Environment defaults ───────────────────────────────────────────────────────
ENV ORC_HOME=/data
ENV NODE_ENV=production
ENV ORC_API_HOST=0.0.0.0
# Default backend: claude (Anthropic SDK). Local CLI launchers are also included.
# Override with ORC_AGENT_LOOP_DEFAULT_BACKEND=acpx if running a host-side
# agent bridge. Disable the task loop entirely with ORC_AGENT_LOOP_ENABLED=false
# and run the runner on the host instead.
ENV ORC_AGENT_LOOP_DEFAULT_BACKEND=claude

# API port (matches default in core config)
EXPOSE 7700

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -fs http://localhost:7700/api/health || exit 1

USER bun

# Use tini as PID 1 so SIGTERM is forwarded and child processes are reaped
ENTRYPOINT ["/usr/local/bin/orc-entrypoint"]
CMD ["bun", "run", "packages/cli/src/index.ts", "daemon", "start"]
