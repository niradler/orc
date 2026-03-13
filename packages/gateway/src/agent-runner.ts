import { createLogger } from "@orc/core/logger";
import { createBackend } from "./agent-runtime/index.js";
import type { AgentSession } from "./agent-runtime/types.js";
import type { PermissionManager } from "./permission-manager.js";
import type { PreviewManager } from "./preview-manager.js";
import { createPermission, updateGatewaySession } from "./store.js";
import type { GatewayAdapter, SupportsInlineButtons } from "./types.js";

const logger = createLogger("gateway:runner");

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export type RunnerContext = {
  chatKey: string;
  chatId: string;
  platform: string;
  adapter: GatewayAdapter;
  permissionManager: PermissionManager;
  session: {
    id: string;
    backend: "claude" | "codex" | "cursor";
    cwd: string;
    model: string | null;
    runtime_session_id: string | null;
    auto_approve: boolean;
    task_id: string | null;
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

  if (!agentSession || !agentSession.alive()) {
    agentSession = await createAgentSession(ctx, prompt);
    activeSessions.set(ctx.session.id, agentSession);
  } else {
    if (ctx.session.backend === "codex") {
      await agentSession.send(prompt);
    } else {
      await agentSession.send(prompt);
    }
  }

  return await driveEventLoop(ctx, agentSession, previewMsgId, preview);
}

async function createAgentSession(
  ctx: RunnerContext,
  initialPrompt: string,
): Promise<AgentSession> {
  const backend = ctx.session.backend;
  const runtimeId = ctx.session.runtime_session_id ?? undefined;

  if (backend === "codex") {
    const { startCodexSession } = await import("./agent-runtime/codex.js");
    return await startCodexSession(
      { cwd: ctx.session.cwd, model: ctx.session.model ?? undefined, runtimeSessionId: runtimeId },
      initialPrompt,
    );
  }

  const backendImpl = createBackend(backend as "claude" | "cursor");
  if (runtimeId) {
    try {
      return await backendImpl.resumeSession(runtimeId, {
        cwd: ctx.session.cwd,
        model: ctx.session.model ?? undefined,
        runtimeSessionId: runtimeId,
      });
    } catch (err) {
      logger.warn(`Failed to resume ${backend} session, starting fresh`, { err });
    }
  }
  const session = await backendImpl.startSession({
    cwd: ctx.session.cwd,
    model: ctx.session.model ?? undefined,
  });
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
  let runtimeSessionId: string | undefined;

  const idleTimer = startIdleWatchdog(ctx.session.id, session);

  try {
    for await (const event of session.events()) {
      idleTimer.reset();

      if (event.type === "text") {
        accumulated += event.data;
        if (preview && previewMsgId) {
          await preview.update(ctx.session.id, accumulated);
        }
        continue;
      }

      if (event.type === "thinking") {
        continue;
      }

      if (event.type === "tool_use") {
        const blurb = `🔧 ${event.data.name}`;
        if (preview && previewMsgId) {
          await preview.update(ctx.session.id, `${accumulated}\n${blurb}`);
        }
        continue;
      }

      if (event.type === "permission_request") {
        const { requestId, tool, command } = event.data;

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
          expiresAt: new Date(Date.now() + 5 * 60 * 1000),
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

        const approved = await ctx.permissionManager.waitFor(requestId);
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
      logger.warn("Idle timeout — closing agent session", { sessionId });
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
