import { createLogger } from "@orc/core/logger";
import { createBackend, hasBackend } from "./agent-runtime/index.js";
import type { AgentSession, SessionOpts } from "./agent-runtime/types.js";
import type { PermissionManager } from "./permission-manager.js";
import type { PreviewManager } from "./preview-manager.js";
import { createPermission, updateGatewaySession } from "./store.js";
import type { GatewayAdapter, SupportsInlineButtons } from "./types.js";

const logger = createLogger("gateway:runner");

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

function toolEmoji(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("read")) return "📖";
  if (n.includes("write")) return "📝";
  if (n.includes("edit")) return "✏️";
  if (n.includes("bash") || n.includes("execute")) return "💻";
  if (n.includes("glob") || n.includes("grep") || n.includes("search")) return "🔍";
  if (n.includes("web")) return "🌐";
  if (n.includes("todo")) return "📋";
  if (n.includes("agent")) return "🤖";
  if (n.includes("memory") || n.includes("mem")) return "🧠";
  if (n.includes("task")) return "📌";
  return "🔧";
}

export type RunnerContext = {
  chatKey: string;
  chatId: string;
  platform: string;
  adapter: GatewayAdapter;
  permissionManager: PermissionManager;
  session: {
    id: string;
    backend: string;
    cwd: string;
    model: string | null;
    runtime_session_id: string | null;
    auto_approve: boolean;
    permission_mode: string | null;
    task_id: string | null;
    acpx_agent: string | null;
    a2a_url: string | null;
  };
  threadId?: string | undefined;
};

type RunResult = {
  output: string;
  runtimeSessionId?: string | undefined;
};

const activeSessions = new Map<string, AgentSession>();

export async function runAgentTurn(
  ctx: RunnerContext,
  prompt: string,
  previewMsgId: string | undefined,
  preview: PreviewManager | null,
): Promise<RunResult> {
  let agentSession = activeSessions.get(ctx.session.id);

  if (!agentSession?.alive()) {
    agentSession = await createAgentSession(ctx, prompt);
    activeSessions.set(ctx.session.id, agentSession);
  } else {
    await agentSession.send(prompt);
  }

  return await driveEventLoop(ctx, agentSession, previewMsgId, preview);
}

async function createAgentSession(
  ctx: RunnerContext,
  initialPrompt: string,
): Promise<AgentSession> {
  const backend = ctx.session.backend;
  const runtimeId = ctx.session.runtime_session_id ?? undefined;

  if (backend === "a2a") {
    const a2aBackend = createBackend("a2a");
    const session = await a2aBackend.startSession({
      cwd: ctx.session.cwd,
      a2aUrl: ctx.session.a2a_url ?? undefined,
      runtimeSessionId: runtimeId,
    });
    await session.send(initialPrompt);
    return session;
  }

  if (backend === "claude") {
    try {
      return await startNativeClaudeSession(ctx, initialPrompt, runtimeId);
    } catch (err) {
      logger.warn("Native claude backend failed, falling back to ACPX", { err });
    }
  }

  // If the backend name is registered in the registry (e.g. "agentapi"), use it directly.
  // Mirrors the same pattern used in task-loop.ts — avoids hard-coding every backend here.
  if (backend !== "claude" && hasBackend(backend)) {
    logger.info("Using registered backend", { backend, cwd: ctx.session.cwd });
    const b = createBackend(backend);
    const opts = claudeSessionOpts(ctx, { runtimeSessionId: runtimeId });
    if (runtimeId) {
      try {
        const resumed = await b.resumeSession(runtimeId, opts);
        await resumed.send(initialPrompt);
        return resumed;
      } catch (err) {
        logger.warn(`Failed to resume ${backend} session, starting fresh`, { err });
      }
    }
    const session = await b.startSession(opts);
    await session.send(initialPrompt);
    return session;
  }

  // Unknown backend name → treat as ACPX agent (e.g. backend="codex" → acpx agent codex)
  const acpxBackend = createBackend("acpx");
  const acpxAgent = ctx.session.acpx_agent ?? backend;
  logger.info("Using ACPX backend", { agent: acpxAgent, cwd: ctx.session.cwd });
  if (runtimeId) {
    try {
      const resumed = await acpxBackend.resumeSession(
        runtimeId,
        claudeSessionOpts(ctx, { acpxAgent, runtimeSessionId: runtimeId }),
      );
      await resumed.send(initialPrompt);
      return resumed;
    } catch (err) {
      logger.warn(`Failed to resume ACPX session for ${acpxAgent}, starting fresh`, { err });
    }
  }
  const session = await acpxBackend.startSession(claudeSessionOpts(ctx, { acpxAgent }));
  await session.send(initialPrompt);
  return session;
}

function claudeSessionOpts(ctx: RunnerContext, extra?: Partial<SessionOpts>): SessionOpts {
  return {
    cwd: ctx.session.cwd,
    model: ctx.session.model ?? undefined,
    autoApprove: ctx.session.auto_approve,
    ...(ctx.session.permission_mode
      ? { permissionMode: ctx.session.permission_mode as SessionOpts["permissionMode"] }
      : {}),
    ...extra,
  };
}

async function startNativeClaudeSession(
  ctx: RunnerContext,
  initialPrompt: string,
  runtimeId: string | undefined,
): Promise<AgentSession> {
  const backendImpl = createBackend("claude");
  if (runtimeId) {
    try {
      const resumed = await backendImpl.resumeSession(
        runtimeId,
        claudeSessionOpts(ctx, { runtimeSessionId: runtimeId }),
      );
      await resumed.send(initialPrompt);
      return resumed;
    } catch (err) {
      logger.warn("Failed to resume native claude session, starting fresh", { err });
    }
  }
  const session = await backendImpl.startSession(claudeSessionOpts(ctx));
  await session.send(initialPrompt);
  return session;
}

async function driveEventLoop(
  ctx: RunnerContext,
  session: AgentSession,
  previewMsgId: string | undefined,
  preview: PreviewManager | null,
): Promise<RunResult> {
  let accumulated = "";
  let statusLine = "";
  let runtimeSessionId: string | undefined;

  const idleTimer = startIdleWatchdog(ctx.session.id, session);

  function previewText(): string {
    return statusLine ? `${accumulated}\n${statusLine}` : accumulated;
  }

  try {
    for await (const event of session.events()) {
      idleTimer.reset();

      if (event.type === "text") {
        accumulated += event.data;
        statusLine = "";
        if (preview && previewMsgId) {
          await preview.update(ctx.session.id, accumulated);
        }
        continue;
      }

      if (event.type === "thinking") {
        continue;
      }

      if (event.type === "tool_use") {
        statusLine = `${toolEmoji(event.data.name)} ${event.data.name}…`;
        if (preview && previewMsgId) {
          await preview.update(ctx.session.id, previewText());
        }
        continue;
      }

      if (event.type === "system_status") {
        statusLine = event.data;
        if (preview && previewMsgId) {
          await preview.update(ctx.session.id, previewText());
        }
        continue;
      }

      if (event.type === "permission_request") {
        const { requestId, tool, command } = event.data;
        logger.info("permission_request received", { requestId, tool });

        if (ctx.session.auto_approve) {
          session.respondPermission(requestId, "approved");
          continue;
        }

        idleTimer.pause();
        if (preview) preview.freeze(ctx.session.id);

        await createPermission({
          chatKey: ctx.chatKey,
          gatewaySessionId: ctx.session.id,
          tool,
          command,
          scope: "once",
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        });

        const buttons = [
          [
            { label: "✅ Allow", value: `perm:approve:${requestId}` },
            { label: "❌ Deny", value: `perm:deny:${requestId}` },
            { label: "🔓 Allow session", value: `perm:session:${requestId}` },
          ],
        ];

        const permText = `🔑 <b>Permission request</b>\n<b>Tool:</b> ${tool}\n<b>Command:</b> <code>${command.slice(0, 200)}</code>`;

        if ("sendWithButtons" in ctx.adapter) {
          await (ctx.adapter as GatewayAdapter & SupportsInlineButtons).sendWithButtons(
            ctx.chatId,
            permText,
            buttons,
            { threadId: ctx.threadId, parseMode: "html" },
          );
        } else {
          await ctx.adapter.send(ctx.chatId, permText, {
            threadId: ctx.threadId,
            parseMode: "html",
          });
        }

        logger.info("waiting for permission", { requestId });
        const approved = await ctx.permissionManager.waitFor(requestId);
        logger.info("permission resolved", { requestId, approved });

        if (!approved) {
          await ctx.adapter.send(
            ctx.chatId,
            "⏰ Permission request timed out or was denied. The agent will continue without that tool.",
            {
              threadId: ctx.threadId,
            },
          );
        }

        session.respondPermission(requestId, approved ? "approved" : "denied");

        if (preview) preview.unfreeze(ctx.session.id);
        idleTimer.resume();
        continue;
      }

      if (event.type === "result") {
        runtimeSessionId = event.data.runtimeSessionId;
        break;
      }

      if (event.type === "error") {
        throw new Error(event.data);
      }
    }
  } finally {
    idleTimer.clear();
  }

  return { output: accumulated.trim() || "(no output)", runtimeSessionId };
}

type IdleWatchdog = { reset(): void; pause(): void; resume(): void; clear(): void };

function startIdleWatchdog(sessionId: string, session: AgentSession): IdleWatchdog {
  let paused = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function arm(): void {
    if (timer) clearTimeout(timer);
    if (paused) return;
    timer = setTimeout(async () => {
      logger.warn("Idle timeout — force-closing agent session", { sessionId });
      await session.close().catch(() => {});
      activeSessions.delete(sessionId);
      await updateGatewaySession(sessionId, {
        status: "error",
        last_error: "Idle timeout",
        last_activity_at: new Date(),
      });
    }, IDLE_TIMEOUT_MS);
  }

  arm();
  return {
    reset() {
      arm();
    },
    pause() {
      paused = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    resume() {
      paused = false;
      arm();
    },
    clear() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

export async function closeAgentSession(sessionId: string): Promise<void> {
  const session = activeSessions.get(sessionId);
  if (session) {
    activeSessions.delete(sessionId);
    await session.close().catch(() => {});
  }
}

export async function preflightBackends(): Promise<void> {
  const { listRegisteredBackends, createBackend: create } = await import(
    "./agent-runtime/index.js"
  );
  for (const name of listRegisteredBackends()) {
    try {
      const backend = create(name);
      const result = await backend.preflight();
      if (!result.ok) {
        logger.warn(`Agent backend preflight failed: ${name}`, { error: result.error });
      } else {
        logger.info(`Agent backend ready: ${name}`);
      }
    } catch (err) {
      logger.warn(`Agent backend preflight error: ${name}`, { err });
    }
  }
}
