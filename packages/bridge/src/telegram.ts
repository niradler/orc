import { loadConfig } from "@orc/core/config";
import { ulid } from "@orc/core/ids";
import { createLogger } from "@orc/core/logger";
import { getDb } from "@orc/db/client";
import { bridge_chats, bridge_messages, bridge_permissions, tasks } from "@orc/db/schema";
import { executeJob } from "@orc/runner/executor";
import { eq } from "drizzle-orm";
import { Bot, InlineKeyboard } from "grammy";

const logger = createLogger("bridge:telegram");

export function createTelegramBridge() {
  const config = loadConfig();
  const tgConfig = config.bridge.telegram;

  if (!tgConfig.enabled || !tgConfig.token) {
    throw new Error("Telegram bridge is not configured. Set bridge.telegram.token in config.");
  }

  const bot = new Bot(tgConfig.token);
  const authorizedUsers = new Set(tgConfig.authorized_users.map(String));

  function isAuthorized(userId: number): boolean {
    return authorizedUsers.size === 0 || authorizedUsers.has(String(userId));
  }

  async function getOrCreateChat(platform: string, chatId: string, username?: string) {
    const db = getDb();
    const id = `${platform}:${chatId}`;
    const existing = await db.query.bridge_chats.findFirst({ where: eq(bridge_chats.id, id) });
    if (existing) return existing;

    await db.insert(bridge_chats).values({
      id,
      platform: "telegram",
      chat_id: chatId,
      username,
      mode: tgConfig.mode ?? "direct",
      authorized: isAuthorized(Number(chatId)),
      created_at: new Date(),
    });

    return db.query.bridge_chats.findFirst({ where: eq(bridge_chats.id, id) });
  }

  bot.command("start", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isAuthorized(userId)) return ctx.reply("Unauthorized.");
    await getOrCreateChat("telegram", String(ctx.chat.id), ctx.from?.username);
    await ctx.reply("orc bridge active. Send messages or use /help for commands.");
  });

  bot.command("help", async (ctx) => {
    if (!isAuthorized(ctx.from?.id ?? 0)) return;
    await ctx.reply(
      [
        "/task list — active tasks",
        "/task done <id> — mark done",
        "/mem <query> — search memory",
        "/job list — list jobs",
        "/job run <name> — trigger job",
        "/status — system status",
        "/approve <id> — approve pending permission",
        "/deny <id> — deny pending permission",
      ].join("\n"),
    );
  });

  bot.command("status", async (ctx) => {
    if (!isAuthorized(ctx.from?.id ?? 0)) return;
    const db = getDb();
    const activeTasks = await db.query.tasks.findMany({ limit: 5 });
    const filtered = activeTasks.filter((t) => !["done", "cancelled"].includes(t.status));
    await ctx.reply(`orc status\nActive tasks: ${filtered.length}`);
  });

  bot.command("approve", async (ctx) => {
    if (!isAuthorized(ctx.from?.id ?? 0)) return;
    const db = getDb();
    const id = ctx.match?.trim();
    if (!id) return ctx.reply("Usage: /approve <permission-id>");
    await db
      .update(bridge_permissions)
      .set({ status: "approved", resolved_at: new Date() })
      .where(eq(bridge_permissions.id, id));
    await ctx.reply(`Approved: ${id}`);
  });

  bot.command("deny", async (ctx) => {
    if (!isAuthorized(ctx.from?.id ?? 0)) return;
    const db = getDb();
    const id = ctx.match?.trim();
    if (!id) return ctx.reply("Usage: /deny <permission-id>");
    await db
      .update(bridge_permissions)
      .set({ status: "denied", resolved_at: new Date() })
      .where(eq(bridge_permissions.id, id));
    await ctx.reply(`Denied: ${id}`);
  });

  bot.on("callback_query:data", async (ctx) => {
    const db = getDb();
    const data = ctx.callbackQuery.data;

    if (data.startsWith("approve:")) {
      const taskId = data.slice(8);
      await db
        .update(tasks)
        .set({ status: "done", updated_at: new Date() })
        .where(eq(tasks.id, taskId));
      await ctx.editMessageText("Approved");
      await ctx.answerCallbackQuery("Task approved");
    } else if (data.startsWith("changes:")) {
      const taskId = data.slice(8);
      await db
        .update(tasks)
        .set({ status: "changes_requested", updated_at: new Date() })
        .where(eq(tasks.id, taskId));
      await ctx.editMessageText("Changes requested");
      await ctx.answerCallbackQuery("Changes sent back to agent");
    } else if (data.startsWith("perm_allow:")) {
      const permId = data.slice(11);
      await db
        .update(bridge_permissions)
        .set({ status: "approved", resolved_at: new Date() })
        .where(eq(bridge_permissions.id, permId));
      await ctx.editMessageText("Permission allowed");
      await ctx.answerCallbackQuery("Allowed");
    } else if (data.startsWith("perm_deny:")) {
      const permId = data.slice(10);
      await db
        .update(bridge_permissions)
        .set({ status: "denied", resolved_at: new Date() })
        .where(eq(bridge_permissions.id, permId));
      await ctx.editMessageText("Permission denied");
      await ctx.answerCallbackQuery("Denied");
    }
  });

  bot.on("message:text", async (ctx) => {
    if (!isAuthorized(ctx.from?.id ?? 0)) return;
    const db = getDb();
    const chat = await getOrCreateChat("telegram", String(ctx.chat.id), ctx.from?.username);

    await db.insert(bridge_messages).values({
      id: ulid(),
      chat_id: chat!.id,
      direction: "in",
      text: ctx.message.text,
      created_at: new Date(),
    });

    const mode = chat!.mode;

    if (mode === "direct") {
      await ctx.reply("Direct mode: use /task, /mem, /job, /status commands.");
    } else if (mode.startsWith("job:")) {
      const jobName = mode.slice(4);
      const job = await db.query.jobs.findFirst({ where: (j, { eq }) => eq(j.name, jobName) });
      if (!job) return ctx.reply(`Job not found: ${jobName}`);
      const runId = await executeJob({
        jobId: job.id,
        triggerBy: "bridge-msg",
        envOverrides: { MSG: ctx.message.text },
      });
      await ctx.reply(`Job triggered: ${jobName} (run: ${runId.slice(-6)})`);
    }
  });

  return {
    bot,
    start: () => {
      logger.info("Starting Telegram bridge...");
      return bot.start();
    },
    stop: () => bot.stop(),
    sendReviewCard: async (chatId: string, taskId: string, title: string, summary: string) => {
      const kb = new InlineKeyboard()
        .text("Approve", `approve:${taskId}`)
        .text("Request Changes", `changes:${taskId}`);
      await bot.api.sendMessage(chatId, `Review: ${title}\n\n${summary}`, { reply_markup: kb });
    },
    sendPermissionCard: async (chatId: string, permId: string, tool: string, command: string) => {
      const kb = new InlineKeyboard()
        .text("Allow", `perm_allow:${permId}`)
        .text("Deny", `perm_deny:${permId}`);
      await bot.api.sendMessage(chatId, `Permission request\nTool: ${tool}\nCommand: ${command}`, {
        reply_markup: kb,
      });
    },
  };
}
