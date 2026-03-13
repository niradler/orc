import { loadConfig } from "@orc/core/config";
import { createLogger } from "@orc/core/logger";
import { Bot, InlineKeyboard, InputFile } from "grammy";
import { registerAdapter } from "./adapter-registry.js";
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

const logger = createLogger("gateway:telegram");

const DEDUP_TTL_MS = 60_000;

type TelegramAdapter = GatewayAdapter &
  SupportsMessageUpdate &
  SupportsInlineButtons &
  SupportsVoice &
  SupportsTyping &
  SupportsCommandRegistration;

function buildKeyboard(buttons: NonNullable<SendOpts["buttons"]>): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const row of buttons) {
    for (const btn of row) {
      kb.text(btn.label, btn.value);
    }
    kb.row();
  }
  return kb;
}

function escapeMd(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

export function createTelegramAdapter(startTime: number): TelegramAdapter {
  const config = loadConfig();
  const token = config.gateway.telegram.token;
  if (!token) throw new Error("Telegram token is not configured.");

  const bot = new Bot(token);
  const seenIds = new Map<string, number>();
  let listener: ((message: IncomingMessage) => Promise<void>) | null = null;

  function isAuthorized(userId: number): boolean {
    const allowed = config.gateway.telegram.authorized_users.map(String);
    return allowed.length > 0 && allowed.includes(String(userId));
  }

  function dedup(msgId: string): boolean {
    const now = Date.now();
    if (seenIds.has(msgId)) return true;
    seenIds.set(msgId, now);
    for (const [id, ts] of seenIds) {
      if (now - ts > DEDUP_TTL_MS) seenIds.delete(id);
    }
    return false;
  }

  function isTooOld(date: Date | undefined): boolean {
    if (!date) return false;
    return date.getTime() < startTime;
  }

  async function download(fileId: string): Promise<Uint8Array> {
    const file = await bot.api.getFile(fileId);
    const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async function dispatch(msg: IncomingMessage): Promise<void> {
    if (listener) await listener(msg);
  }

  function makeIncoming(
    ctx: any,
    text: string,
    attachments?: IncomingMessage["attachments"],
  ): IncomingMessage {
    return {
      platform: "telegram",
      chatId: String(ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id ?? ""),
      userId: String(ctx.from.id),
      username: ctx.from.username,
      displayName:
        [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ").trim() || undefined,
      text,
      platformMessageId: String(ctx.msg?.message_id ?? ctx.message?.message_id ?? ""),
      attachments,
    };
  }

  return {
    platform: "telegram",

    async start(onMessage) {
      listener = onMessage;

      const allCommands = [
        "start",
        "help",
        "status",
        "mode",
        "cwd",
        "agent",
        "tasks",
        "task",
        "approve",
        "reject",
        "assign",
        "jobs",
        "run",
        "mem",
        "sessions",
        "session",
      ];

      bot.command(allCommands, async (ctx: any) => {
        if (!ctx.from || !isAuthorized(ctx.from.id)) return;
        const msgId = String(ctx.message?.message_id ?? "");
        if (msgId && dedup(`cmd:${msgId}`)) return;
        if (isTooOld(ctx.message?.date ? new Date(ctx.message.date * 1000) : undefined)) return;

        const cmdName =
          ctx.message?.text?.split(" ")[0]?.replace(/^\//, "").split("@")[0] ?? "help";
        const argsPart = ctx.message?.text?.split(" ").slice(1).join(" ") ?? "";
        const text = argsPart ? `/${cmdName} ${argsPart}` : `/${cmdName}`;
        await dispatch(makeIncoming(ctx, text));
      });

      bot.on("message", async (ctx: any) => {
        if (!ctx.from || !isAuthorized(ctx.from.id)) return;
        const msgId = String(ctx.message?.message_id ?? "");
        if (msgId && dedup(`msg:${msgId}`)) return;
        if (isTooOld(ctx.message?.date ? new Date(ctx.message.date * 1000) : undefined)) return;

        const attachments: IncomingMessage["attachments"] = [];
        if (ctx.message?.voice) {
          try {
            attachments.push({
              kind: "audio",
              data: await download(ctx.message.voice.file_id),
              mimeType: ctx.message.voice.mime_type ?? "audio/ogg",
              format: "ogg",
              duration: ctx.message.voice.duration,
            });
          } catch (err) {
            logger.warn("Failed to download voice message", { err });
          }
        }
        if (ctx.message?.audio) {
          try {
            attachments.push({
              kind: "audio",
              data: await download(ctx.message.audio.file_id),
              mimeType: ctx.message.audio.mime_type ?? "audio/mpeg",
              format: (ctx.message.audio.mime_type ?? "audio/mpeg").split("/").at(1) ?? "mp3",
              duration: ctx.message.audio.duration,
            });
          } catch (err) {
            logger.warn("Failed to download audio message", { err });
          }
        }

        const rawText = ctx.message?.text ?? ctx.message?.caption ?? "";
        if (!rawText && attachments.length === 0) return;

        await dispatch(
          makeIncoming(ctx, rawText, attachments.length > 0 ? attachments : undefined),
        );
      });

      bot.on("callback_query:data", async (ctx: any) => {
        if (!ctx.from || !isAuthorized(ctx.from.id)) return;
        const cbId = ctx.callbackQuery.id;
        if (dedup(`cb:${cbId}`)) {
          await ctx.answerCallbackQuery();
          return;
        }
        const chatId = String(ctx.callbackQuery.message?.chat.id ?? ctx.chat?.id ?? "");
        const platformMessageId = `${chatId}:${ctx.callbackQuery.message?.message_id}`;
        await dispatch({
          platform: "telegram",
          chatId,
          userId: String(ctx.from.id),
          username: ctx.from.username,
          displayName:
            [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ").trim() || undefined,
          text: ctx.callbackQuery.data,
          platformMessageId,
        });
        await ctx.answerCallbackQuery();
      });

      logger.info("Starting Telegram gateway adapter");
      void bot.start({ allowed_updates: ["message", "callback_query"] });
    },

    async stop() {
      bot.stop();
    },

    async send(chatId, text, opts) {
      const params: Record<string, unknown> = {};
      if (opts?.parseMode === "html") params.parse_mode = "HTML";
      if (opts?.buttons?.length) params.reply_markup = buildKeyboard(opts.buttons);

      const safe = text.slice(0, 4096);
      const sent = await bot.api.sendMessage(chatId, safe, params as any);
      return `${sent.chat.id}:${sent.message_id}`;
    },

    async updateMessage(chatId, msgId, text, opts) {
      const [, rawId] = msgId.split(":");
      if (!rawId) return;
      const params: Record<string, unknown> = {};
      if (opts?.parseMode === "html") params.parse_mode = "HTML";
      if (opts?.buttons?.length) params.reply_markup = buildKeyboard(opts.buttons);
      try {
        await bot.api.editMessageText(chatId, Number(rawId), text.slice(0, 4096), params as any);
      } catch (err: any) {
        if (!String(err?.message ?? "").includes("message is not modified")) throw err;
      }
    },

    async sendWithButtons(chatId, text, buttons, opts) {
      const params: Record<string, unknown> = { reply_markup: buildKeyboard(buttons) };
      if (opts?.parseMode === "html") params.parse_mode = "HTML";
      const sent = await bot.api.sendMessage(chatId, text.slice(0, 4096), params as any);
      return `${sent.chat.id}:${sent.message_id}`;
    },

    async downloadAudio(fileId) {
      return download(fileId);
    },

    async sendAudio(chatId, audio, format, caption) {
      const ext = format === "ogg" || format === "oga" ? "ogg" : "mp3";
      const file = new InputFile(audio, `audio.${ext}`);
      const opts = caption ? { caption } : {};
      if (ext === "ogg") {
        await bot.api.sendVoice(chatId, file, opts);
      } else {
        await bot.api.sendAudio(chatId, file, opts);
      }
    },

    async showTyping(chatId) {
      try {
        await bot.api.sendChatAction(chatId, "typing");
      } catch {
        // ignore
      }
    },

    async registerCommands(commands) {
      await bot.api.setMyCommands(
        commands.map((c) => ({ command: c.command, description: c.description })),
      );
    },
  };
}

registerAdapter("telegram", (startTime) => createTelegramAdapter(startTime));
