# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM oven/bun:1-alpine AS builder
WORKDIR /app

# Copy manifests first so dependency install is cached when only source changes
COPY package.json bun.lock* tsconfig.json ./
COPY patches/ patches/
COPY packages/agent-runtime/package.json packages/agent-runtime/
COPY packages/api/package.json            packages/api/
COPY packages/cli/package.json            packages/cli/
COPY packages/core/package.json           packages/core/
COPY packages/db/package.json             packages/db/
COPY packages/gateway/package.json        packages/gateway/
COPY packages/mcp/package.json            packages/mcp/
COPY packages/runner/package.json         packages/runner/
COPY packages/sdk/package.json            packages/sdk/
COPY packages/task-service/package.json   packages/task-service/
COPY packages/web/package.json            packages/web/

# qmd's tree-sitter packages compile native addons (node-gyp) during install
RUN apk add --no-cache python3 build-base

RUN bun install --frozen-lockfile

# Copy source and build the web dashboard (embedded into CLI/server)
COPY packages/ packages/
COPY skills/ skills/

RUN bun run --filter @orc/web build && \
    cd packages/cli && bun run build:copy-web

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM oven/bun:1-alpine AS runner
WORKDIR /app

# The Bun base image provides the unprivileged `bun` user (UID 1000), which
# keeps mounted SSH credentials and persistent data readable when they belong
# to the host user.

# Minimal runtime OS packages — tini for correct signal forwarding + PID 1
RUN apk add --no-cache tini curl git openssh-client ripgrep

# Copy only the runtime artifacts from the builder
COPY --from=builder --chown=bun:bun /app/node_modules   ./node_modules
COPY --from=builder --chown=bun:bun /app/packages        ./packages
COPY --from=builder --chown=bun:bun /app/skills          ./skills
COPY --from=builder --chown=bun:bun /app/package.json    ./

# Persistent data dir (SQLite DB, logs). Mount a named volume here.
RUN mkdir -p /data && chown bun:bun /data

COPY docker-entrypoint.sh /usr/local/bin/orc-entrypoint
RUN chmod 755 /usr/local/bin/orc-entrypoint

# ── Environment defaults ───────────────────────────────────────────────────────
ENV ORC_HOME=/data
ENV NODE_ENV=production
ENV ORC_API_HOST=0.0.0.0
# Default backend: claude (Anthropic SDK, direct API — no CLI tooling required).
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
