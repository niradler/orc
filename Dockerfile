# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM oven/bun:1-alpine AS builder
WORKDIR /app

# Copy manifests first so dependency install is cached when only source changes
COPY package.json bun.lock* ./
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

RUN bun install --frozen-lockfile

# Copy source and build the web dashboard (embedded into CLI/server)
COPY packages/ packages/

RUN bun run --filter @orc/web build && \
    cd packages/cli && bun run build:copy-web

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM oven/bun:1-alpine AS runner
WORKDIR /app

# Non-root user for least-privilege execution
RUN addgroup -S orc && adduser -S -G orc orc

# Minimal runtime OS packages — tini for correct signal forwarding + PID 1
RUN apk add --no-cache tini curl

# Copy only the runtime artifacts from the builder
COPY --from=builder --chown=orc:orc /app/node_modules   ./node_modules
COPY --from=builder --chown=orc:orc /app/packages        ./packages
COPY --from=builder --chown=orc:orc /app/package.json    ./

# Persistent data dir (SQLite DB, logs). Mount a named volume here.
RUN mkdir -p /data && chown orc:orc /data

# ── Environment defaults ───────────────────────────────────────────────────────
ENV ORC_HOME=/data
ENV NODE_ENV=production
# Default backend: claude (Anthropic SDK, direct API — no CLI tooling required).
# Override with ORC_AGENT_LOOP_DEFAULT_BACKEND=acpx if running a host-side
# agent bridge. Disable the task loop entirely with ORC_AGENT_LOOP_ENABLED=false
# and run the runner on the host instead.
ENV ORC_AGENT_LOOP_DEFAULT_BACKEND=claude

# API port (matches default in core config)
EXPOSE 7700

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -fs http://localhost:7700/api/health || exit 1

USER orc

# Use tini as PID 1 so SIGTERM is forwarded and child processes are reaped
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "run", "packages/cli/src/index.ts", "daemon", "start"]
