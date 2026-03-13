import { existsSync } from "node:fs";
import { loadConfig } from "@orc/core/config";
import { createLogger } from "@orc/core/logger";
import type { GatewayMode } from "@orc/core/types";
import { executeJob } from "@orc/runner/executor";
import { createAdapter } from "./adapter-registry.js";
import { closeAgentSession, preflightBackends, runAgentTurn } from "./agent-runner.js";
import { RateLimiter } from "./rate-limiter.js";
import { redactSecrets } from "./redact.js";
import "./agent-runtime/index.js";
import { ensureAgentSession, handleDirectCommand } from "./direct.js";
import { PermissionManager } from "./permission-manager.js";
import { PreviewManager } from "./preview-manager.js";
import { SessionLock } from "./session-lock.js";
import "./slack.js";
import { synthesizeSpeech, transcribeAudio } from "./speech.js";
import "./telegram.js";
import {
  appendMessage,
  findJobByName,
  getActiveGatewaySession,
  getOrCreateChat,
  listReviewTargets,
  updateGatewaySession,
} from "./store.js";
import type {
  GatewayAdapter,
  IncomingMessage,
  SendOpts,
  SupportsCommandRegistration,
  SupportsInlineButtons,
  SupportsMessageUpdate,
  SupportsTyping,
  SupportsVoice,
} from "./types.js";

const logger = createLogger("gateway");

const BOT_COMMANDS = [
  { command: "help", description: "Show available commands" },
  { command: "status", description: "System status and sessions" },
  { command: "tasks", description: "List active tasks" },
  { command: "task", description: "Task details: /task <id>" },
  { command: "approve", description: "Approve task or permission" },
  { command: "reject", description: "Reject task or deny permission" },
  { command: "assign", description: "Assign task to agent: /assign <id> <agent>" },
  { command: "jobs", description: "List jobs" },
  { command: "run", description: "Run a job: /run <name>" },
  { command: "mem", description: "Search memories: /mem <query>" },
  { command: "agent", description: "Switch agent: /agent claude|codex|cursor" },
  { command: "sessions", description: "List agent sessions" },
  { command: "session", description: "Session lifecycle: new|list|switch|stop" },
  { command: "mode", description: "Switch routing mode" },
  { command: "cwd", description: "Set working directory" },
];

let manager: GatewayManager | null = null;

class GatewayManager {
  private readonly adapters = new Map<string, GatewayAdapter>();
  private readonly sessionLock = new SessionLock();
  private readonly permissionManager = new PermissionManager();
  private readonly startTime = Date.now();
  private readonly adapterStatus = new Map<string, { error?: string }>();
  private readonly pendingSessionApprove = new Set<string>();
  private readonly rateLimiter = new RateLimiter();

  async start(): Promise<void> {
    const config = loadConfig();

    const enabledAdapters: string[] = [];
    if (config.gateway.telegram.enabled && config.gateway.telegram.token)
      enabledAdapters.push("telegram");
    if (
      config.gateway.slack.enabled &&
      config.gateway.slack.bot_token &&
      config.gateway.slack.app_token
    )
      enabledAdapters.push("slack");

    for (const name of enabledAdapters) {
      try {
        const adapter = createAdapter(name, this.startTime);
        this.adapters.set(adapter.platform, adapter);
        await this.safeStart(adapter);
      } catch (err) {
        const errMsg = redactSecrets(String(err));
        logger.error(`Failed to create ${name} adapter`, errMsg);
        this.adapterStatus.set(name, { error: errMsg });
      }
    }

    for (const [, adapter] of this.adapters) {
      if ("registerCommands" in adapter) {
        try {
          await (adapter as SupportsCommandRegistration).registerCommands(BOT_COMMANDS);
        } catch (err) {
          logger.warn("Failed to register bot commands", { platform: adapter.platform, err });
        }
      }
    }

    await preflightBackends();

    const config2 = loadConfig();
    for (const platform of ["telegram", "slack"] as const) {
      const cfg = config2.gateway[platform];
      if (cfg.enabled && cfg.authorized_users.length === 0) {
        logger.warn(
          `${platform}: authorized_users is empty — all users will be denied. Add user IDs to config.`,
        );
      }
    }

    const names = [...this.adapters.keys()].join(", ");
    logger.info(`Gateway started with adapters: ${names || "none"}`);
  }

  async stop(): Promise<void> {
    this.permissionManager.denyAll();
    await Promise.all([...this.adapters.values()].map((a) => a.stop().catch(() => {})));
    this.adapters.clear();
  }

  resolvePermission(requestId: string, approved: boolean): boolean {
    return this.permissionManager.resolve(requestId, approved);
  }

  private async safeStart(adapter: GatewayAdapter): Promise<void> {
    try {
      await adapter.start(async (msg) => this.handleIncoming(msg));
      this.adapterStatus.set(adapter.platform, {});
    } catch (err) {
      this.adapterStatus.set(adapter.platform, { error: String(err) });
      logger.error(`Failed to start ${adapter.platform} adapter`, redactSecrets(String(err)));
    }
  }

  private normalizeCallbackText(text: string): string {
    if (text.startsWith("task:approve:")) return `/approve ${text.slice("task:approve:".length)}`;
    if (text.startsWith("task:reject:")) return `/reject ${text.slice("task:reject:".length)}`;
    if (text.startsWith("perm:approve:")) {
      const id = text.slice("perm:approve:".length);
      if (this.permissionManager.resolve(id, true)) return `__perm_resolved:${id}:approved`;
      return `/approve ${id}`;
    }
    if (text.startsWith("perm:deny:")) {
      const id = text.slice("perm:deny:".length);
      if (this.permissionManager.resolve(id, false)) return `__perm_resolved:${id}:denied`;
      return `/reject ${id}`;
    }
    if (text.startsWith("perm:session:")) {
      const id = text.slice("perm:session:".length);
      this.permissionManager.resolve(id, true);
      this.pendingSessionApprove.add(id);
      return `__perm_resolved:${id}:session`;
    }
    return text;
  }

  private async handleIncoming(message: IncomingMessage): Promise<void> {
    const config = loadConfig();
    const gatewayConfig = config.gateway[message.platform as "telegram" | "slack"];
    const authorizedUsers = gatewayConfig.authorized_users.map(String);
    const chat = await getOrCreateChat({
      platform: message.platform,
      chatId: message.chatId,
      username: message.username,
      displayName: message.displayName,
      authorized: authorizedUsers.length > 0 && authorizedUsers.includes(message.userId),
      mode: gatewayConfig.mode as GatewayMode,
      threadId: message.threadId,
    });
    if (!chat.authorized) return;

    if (!this.rateLimiter.allow(chat.id)) {
      await this.sendText(message, "⏸ Slow down — too many messages. Try again in a minute.");
      return;
    }

    let text = message.text.trim();
    const audio = message.attachments?.find((a) => a.kind === "audio");

    if (text) {
      text = this.normalizeCallbackText(text);
      if (text.startsWith("__perm_resolved:")) {
        const parts = text.split(":");
        const resolution = parts[2];
        const replyText =
          resolution === "approved"
            ? "✅ Permission approved."
            : resolution === "session"
              ? "✅ Permission approved for this session."
              : "❌ Permission denied.";
        await this.sendText(message, replyText);
        if (resolution === "session") {
          const active = await getActiveGatewaySession(chat.id);
          if (active) await updateGatewaySession(active.id, { auto_approve: true });
        }
        return;
      }
    }

    if (!text && audio && config.speech.enabled) {
      try {
        const transcript = await transcribeAudio({ audio: audio.data, format: audio.format });
        await this.handleIncoming({
          ...message,
          text: transcript,
          fromVoice: true,
          attachments: [],
        });
        return;
      } catch (err) {
        await this.sendText(
          message,
          `Voice transcription failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
    }

    if (!text) {
      await this.sendText(message, "Send text or a voice message.");
      return;
    }

    await appendMessage({
      chatKey: chat.id,
      direction: "in",
      role: "user",
      text,
      platformMessageId: message.platformMessageId,
      threadId: message.threadId,
      metadata: message.fromVoice ? { from_voice: true } : undefined,
    });

    const commandResult = await handleDirectCommand({
      chatKey: chat.id,
      rawText: text,
      currentMode: chat.mode as GatewayMode,
      currentWorkingDir: chat.working_dir,
    });

    if (commandResult) {
      if (commandResult.mode) chat.mode = commandResult.mode;
      const outText = commandResult.html ?? commandResult.text ?? "";
      const plainText = commandResult.text ?? outText;
      const parseMode = commandResult.html ? ("html" as const) : undefined;
      const adapter = this.adapters.get(message.platform);
      if (adapter && commandResult.buttons?.length && "sendWithButtons" in adapter) {
        await (adapter as GatewayAdapter & SupportsInlineButtons).sendWithButtons(
          message.chatId,
          outText,
          commandResult.buttons,
          { threadId: message.threadId, parseMode },
        );
      } else if (adapter) {
        await adapter.send(message.chatId, outText, { threadId: message.threadId, parseMode });
      }
      if (message.fromVoice && plainText) await this.trySendVoiceReply(message, plainText);
      await appendMessage({
        chatKey: chat.id,
        direction: "out",
        role: "system",
        text: plainText,
        threadId: message.threadId,
      });
      return;
    }

    if (chat.mode.startsWith("job:")) {
      const jobName = chat.mode.slice(4);
      const job = await findJobByName(jobName);
      const reply = job
        ? `Triggered ${job.name} → ${await executeJob({ jobId: job.id, triggerBy: "bridge-msg", envOverrides: { MSG: text } })}`
        : `Job not found: ${jobName}`;
      await this.sendText(message, reply);
      if (message.fromVoice) await this.trySendVoiceReply(message, reply);
      await appendMessage({
        chatKey: chat.id,
        direction: "out",
        role: "system",
        text: reply,
        threadId: message.threadId,
      });
      return;
    }

    if (chat.mode === "direct") {
      const reply =
        "Direct mode active. Use /help for commands, or /agent claude to start an agent session.";
      await this.sendText(message, reply);
      await appendMessage({
        chatKey: chat.id,
        direction: "out",
        role: "system",
        text: reply,
        threadId: message.threadId,
      });
      return;
    }

    const session = await ensureAgentSession({
      chatKey: chat.id,
      mode: chat.mode as GatewayMode,
      cwd: chat.working_dir,
    });

    if (!this.sessionLock.tryAcquire(session.id)) {
      await this.sendText(message, `⏳ ${session.backend} is still processing — please wait.`);
      return;
    }

    try {
      await this.runAgentTurnWithPreview(message, chat, session, text);
    } finally {
      this.sessionLock.release(session.id);
    }
  }

  private async runAgentTurnWithPreview(
    message: IncomingMessage,
    chat: { id: string; mode: string; working_dir: string | null },
    session: {
      id: string;
      backend: string;
      cwd: string | null;
      model: string | null;
      runtime_session_id: string | null;
      auto_approve: boolean;
      task_id: string | null;
    },
    text: string,
  ): Promise<void> {
    if (!session.cwd || !existsSync(session.cwd)) {
      await this.sendText(message, "Set a working directory first: /cwd <absolute-path>");
      return;
    }

    const adapter = this.adapters.get(message.platform);
    if (!adapter) return;

    if ("showTyping" in adapter) {
      await (adapter as GatewayAdapter & SupportsTyping).showTyping(message.chatId).catch(() => {});
    }

    const previewMsgId = await adapter.send(message.chatId, `${session.backend} is thinking…`, {
      threadId: message.threadId,
    });

    let preview: PreviewManager | null = null;
    if (previewMsgId && PreviewManager.supports(adapter)) {
      preview = new PreviewManager(adapter);
      await preview.init(
        session.id,
        message.chatId,
        previewMsgId,
        `${session.backend} is thinking…`,
      );
    }

    await updateGatewaySession(session.id, { status: "running", last_activity_at: new Date() });

    try {
      const result = await runAgentTurn(
        {
          chatKey: chat.id,
          chatId: message.chatId,
          platform: message.platform,
          adapter,
          permissionManager: this.permissionManager,
          session: {
            id: session.id,
            backend: session.backend as "claude" | "codex" | "cursor",
            cwd: session.cwd,
            model: session.model,
            runtime_session_id: session.runtime_session_id,
            auto_approve: session.auto_approve,
            task_id: session.task_id,
          },
          threadId: message.threadId,
        },
        text,
        previewMsgId,
        preview,
      );

      await updateGatewaySession(session.id, {
        status: "idle",
        runtime_session_id: result.runtimeSessionId,
        last_activity_at: new Date(),
        last_error: null,
      });

      if (preview && previewMsgId) {
        await preview.finalize(session.id, result.output);
      } else if (previewMsgId && "updateMessage" in adapter) {
        await (adapter as GatewayAdapter & SupportsMessageUpdate)
          .updateMessage(message.chatId, previewMsgId, result.output, {
            threadId: message.threadId,
          })
          .catch(() => adapter.send(message.chatId, result.output, { threadId: message.threadId }));
      } else {
        await adapter.send(message.chatId, result.output, { threadId: message.threadId });
      }

      await appendMessage({
        chatKey: chat.id,
        direction: "out",
        role: "assistant",
        text: result.output,
        gatewaySessionId: session.id,
        threadId: message.threadId,
        platformMessageId: previewMsgId,
      });

      if (message.fromVoice) await this.trySendVoiceReply(message, result.output);
    } catch (err) {
      preview?.cleanup(session.id);
      const errorText = `Agent error: ${err instanceof Error ? err.message : String(err)}`;
      await updateGatewaySession(session.id, {
        status: "error",
        last_error: errorText,
        last_activity_at: new Date(),
      });
      const errMsg = errorText.slice(0, 1000);
      if (previewMsgId && "updateMessage" in adapter) {
        await (adapter as GatewayAdapter & SupportsMessageUpdate)
          .updateMessage(message.chatId, previewMsgId, errMsg, { threadId: message.threadId })
          .catch(() => adapter.send(message.chatId, errMsg, { threadId: message.threadId }));
      } else {
        await adapter.send(message.chatId, errMsg, { threadId: message.threadId }).catch(() => {});
      }

      if (err instanceof Error && /auth|api.key|401/i.test(err.message)) {
        await closeAgentSession(session.id);
      }
    }
  }

  private async sendText(message: IncomingMessage, text: string): Promise<void> {
    const adapter = this.adapters.get(message.platform);
    if (!adapter) return;
    await adapter.send(message.chatId, text, { threadId: message.threadId });
  }

  private async trySendVoiceReply(message: IncomingMessage, text: string): Promise<void> {
    const config = loadConfig();
    if (!config.tts.enabled) return;
    const adapter = this.adapters.get(message.platform);
    if (!adapter || !("sendAudio" in adapter)) return;
    try {
      const tts = await synthesizeSpeech(text);
      await (adapter as GatewayAdapter & SupportsVoice).sendAudio(
        message.chatId,
        tts.audio,
        tts.format,
        "Voice reply",
      );
    } catch (err) {
      logger.warn("TTS failed", { err });
    }
  }

  async notifyTaskReview(input: { taskId: string; title: string; summary: string }): Promise<void> {
    const targets = await listReviewTargets();
    const text = `👀 <b>Review requested</b>\n\n<b>${input.title}</b>\n${input.summary.slice(0, 400)}`;
    const buttons = [
      [
        { label: "✅ Approve", value: `task:approve:${input.taskId}` },
        { label: "🔁 Changes", value: `task:reject:${input.taskId}` },
      ],
    ];
    await Promise.all(
      targets.map(async (chat) => {
        const adapter = this.adapters.get(chat.platform);
        if (!adapter) return;
        try {
          if ("sendWithButtons" in adapter) {
            await (adapter as GatewayAdapter & SupportsInlineButtons).sendWithButtons(
              chat.chat_id,
              text,
              buttons,
              { parseMode: "html" },
            );
          } else {
            await adapter.send(chat.chat_id, text, { parseMode: "html" });
          }
        } catch (err) {
          logger.warn("Failed to send review notification", { err, chat: chat.id });
        }
      }),
    );
  }

  async sendToChat(platform: string, chatId: string, text: string, opts?: SendOpts): Promise<void> {
    const adapter = this.adapters.get(platform);
    if (!adapter) throw new Error(`Adapter not available: ${platform}`);
    await adapter.send(chatId, text, opts);
  }

  getStatus(): {
    adapters: Array<{ name: string; error?: string | undefined }>;
    startTime: number;
  } {
    return {
      adapters: [...this.adapters.keys()].map((name) => {
        const err = this.adapterStatus.get(name)?.error;
        return err ? { name, error: err } : { name };
      }),
      startTime: this.startTime,
    };
  }
}

export async function startGateway(): Promise<void> {
  if (manager) return;
  manager = new GatewayManager();
  await manager.start();
}

export async function stopGateway(): Promise<void> {
  if (!manager) return;
  await manager.stop();
  manager = null;
}

export function getGatewayManager(): GatewayManager | null {
  return manager;
}

export async function notifyTaskReview(input: {
  taskId: string;
  title: string;
  summary: string;
}): Promise<void> {
  await manager?.notifyTaskReview(input);
}

export async function sendGatewayMessage(
  platform: string,
  chatId: string,
  text: string,
  opts?: SendOpts,
): Promise<void> {
  await manager?.sendToChat(platform, chatId, text, opts);
}

export function getGatewayStatus(): string {
  if (!manager) return "Gateway not running.";
  const { adapters, startTime } = manager.getStatus();
  const lines = [
    `Started: ${new Date(startTime).toISOString()}`,
    `Adapters: ${adapters.length > 0 ? adapters.map((a) => `${a.name}${a.error ? ` (ERROR: ${a.error})` : " ✓"}`).join(", ") : "none"}`,
  ];
  return lines.join("\n");
}
