import { ChannelBuiltinCommands, channelCommands } from "@orc/core/channels";
import { ValidationError } from "@orc/core/errors";
import { UPLOAD_MAX_BYTES } from "@orc/core/session-file-types";
import {
  type ChannelProvider,
  downloadBounded,
  type NativePayload,
  ProviderFailure,
  postJson,
} from "./base.js";
import { escapeText, type MarkdownMarks, renderText } from "./markdown.js";
import {
  telegramContext,
  telegramFile,
  telegramFiles,
  telegramReaction,
} from "./telegram-inbound.js";

const marks: MarkdownMarks = {
  strong: (t) => `<b>${t}</b>`,
  em: (t) => `<i>${t}</i>`,
  del: (t) => `<s>${t}</s>`,
  code: (t) => `<code>${t}</code>`,
  pre: (t) => `<pre>${t}</pre>\n`,
  link: (url, t) => `<a href="${escapeText(url).replace(/"/g, "&quot;")}">${t}</a>`,
  heading: (t) => `<b>${t}</b>`,
  quote: (t) => `<blockquote>${t}</blockquote>\n`,
};

async function call(
  token: string,
  method: string,
  payload: NativePayload = {},
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const { status, body } = await postJson(
    `https://api.telegram.org/bot${token}/${method}`,
    {},
    payload,
    signal,
  );
  if (
    method === "editMessageText" &&
    Number(body.error_code) === 400 &&
    String(body.description).includes("message is not modified")
  )
    return {};
  if (status >= 400 || !body.ok)
    throw new ProviderFailure(`http_${status}_code_${Number(body.error_code) || 0}`, status >= 500);
  return body.result as Record<string, unknown>;
}

export const telegram: ChannelProvider = {
  info: {
    id: "telegram",
    name: "Telegram",
    credentials: [{ key: "token", label: "Bot token", env: "ORC_TELEGRAM_TOKEN" }],
    documentation: "https://core.telegram.org/bots/api#sendmessage",
    capabilities: {
      markdown: true,
      links: true,
      buttons: true,
      edit: true,
      threads: true,
      files: true,
      native_overrides: true,
    },
    setup: [
      "Create a bot with @BotFather, or use the configured token.",
      "Verify bot identity, then open a pairing link in your private chat.",
      "Confirm your identity in ORC, choose inbound routes, and send a test.",
    ],
  },
  accountKey: "token",
  replyControls: true,
  render(message) {
    const { chunks, warnings } = renderText(message, marks, 4000);
    const payloads: NativePayload[] = chunks.map((text) => ({ text, parse_mode: "HTML" }));
    const last = payloads.at(-1);
    if (last && message.links.length)
      last.reply_markup = {
        inline_keyboard: message.links.map((link) => [{ text: link.label, url: link.url }]),
      };
    return { payloads, warnings };
  },
  destination: (chat, thread) => ({
    chat_id: chat,
    ...(thread ? { message_thread_id: Number(thread) } : {}),
  }),
  controls: (_text, _format, rows) => ({
    reply_markup: {
      inline_keyboard: rows.map((row) =>
        row.map((b) => ({ text: b.label, callback_data: b.value })),
      ),
    },
  }),
  pairing: (identity, token) => ({
    url: `https://t.me/${encodeURIComponent(identity.name)}?start=orc_${token}`,
    message: `/start orc_${token}`,
  }),
  transport(connection, credentials, state) {
    const token = credentials.token;
    if (!token) throw new ValidationError("Missing channel bot token");
    let stopped = false;
    let abort: AbortController | undefined;
    let loop: Promise<void> | undefined;
    let botName = "";
    return {
      async downloadFile(file) {
        if (file.customEmojiId) {
          if (!/^\d{1,30}$/.test(file.customEmojiId))
            throw new ProviderFailure("invalid_file_path");
          const stickers = await call(token, "getCustomEmojiStickers", {
            custom_emoji_ids: [file.customEmojiId],
          });
          const sticker = Array.isArray(stickers)
            ? stickers.find((item) => item?.custom_emoji_id === file.customEmojiId)
            : undefined;
          const resolved = telegramFile("sticker", sticker, file.customEmojiId);
          if (!resolved) throw new ProviderFailure("invalid_response");
          file = { ...resolved, description: `Telegram custom emoji; ${resolved.description}` };
        }
        if (file.size !== undefined && file.size > UPLOAD_MAX_BYTES)
          throw new ValidationError("Telegram files must be at most 20 MB");
        const result = await call(token, "getFile", { file_id: file.fileId });
        if (Number(result.file_size) > UPLOAD_MAX_BYTES)
          throw new ValidationError("Telegram files must be at most 20 MB");
        const path = result.file_path;
        if (
          typeof path !== "string" ||
          !/^[a-zA-Z0-9_./-]+$/.test(path) ||
          path.split("/").includes("..")
        )
          throw new ProviderFailure("invalid_file_path");
        return downloadBounded(
          `https://api.telegram.org/file/bot${token}/${path}`,
          {},
          file,
          "Telegram",
        );
      },
      async identity() {
        const body = await call(token, "getMe");
        botName = String(body.username ?? "");
        const id = String(body.id ?? "");
        return { id, name: botName || id };
      },
      async send(payload) {
        const result = await call(token, "sendMessage", payload);
        return String(result.message_id);
      },
      async edit(id, payload) {
        await call(token, "editMessageText", {
          ...payload,
          message_id: Number(id),
          reply_markup: payload.reply_markup ?? { inline_keyboard: [] },
        });
      },
      async start(receive, failed) {
        stopped = false;
        const startedAt = Date.now();
        const info = await call(token, "getWebhookInfo");
        if (info.url) throw new ProviderFailure("webhook_already_owned");
        await call(token, "setMyCommands", {
          commands: [...ChannelBuiltinCommands, ...channelCommands(connection.config)].map(
            ({ command, description }) => ({ command, description }),
          ),
        });
        let offset = Number(state?.loadCursor() ?? 0);
        const resumeCursor = offset > 0;
        loop = (async () => {
          while (!stopped) {
            abort = new AbortController();
            try {
              const result = (await call(
                token,
                "getUpdates",
                {
                  offset,
                  timeout: 25,
                  allowed_updates: [
                    "message",
                    "edited_message",
                    "callback_query",
                    "message_reaction",
                  ],
                },
                AbortSignal.any([abort.signal, AbortSignal.timeout(35000)]),
              )) as unknown as Array<Record<string, unknown>>;
              failed("");
              for (const update of result) {
                offset = Number(update.update_id) + 1;
                try {
                  if (update.message_reaction) {
                    const reaction = telegramReaction(update, connection.id);
                    if (
                      reaction &&
                      (resumeCursor ||
                        Number((update.message_reaction as Record<string, unknown>).date) * 1000 >=
                          startedAt - 1000)
                    )
                      receive(reaction);
                    continue;
                  }
                  const callback = update.callback_query as Record<string, unknown> | undefined;
                  const msg = (update.message ?? update.edited_message ?? callback?.message) as
                    | Record<string, unknown>
                    | undefined;
                  const from = (callback?.from ?? msg?.from) as Record<string, unknown> | undefined;
                  const chat = msg?.chat as Record<string, unknown> | undefined;
                  if (!msg || !from || !chat || from.is_bot) continue;
                  if (
                    !resumeCursor &&
                    !callback &&
                    Number(msg.edit_date ?? msg.date) * 1000 < startedAt - 1000
                  )
                    continue;
                  if (callback)
                    void call(token, "answerCallbackQuery", {
                      callback_query_id: callback.id,
                    }).catch(() => {});
                  const attachments = callback ? [] : telegramFiles(msg);
                  const context = callback ? undefined : telegramContext(msg);
                  if (!callback && !attachments.length && !context && !msg.text && !msg.caption)
                    continue;
                  receive({
                    connection: connection.id,
                    sender: String(from.id),
                    sender_name:
                      [from.first_name, from.last_name].filter(Boolean).join(" ") ||
                      (from.username ? String(from.username) : undefined),
                    chat: String(chat.id),
                    ...(msg.message_thread_id ? { thread: String(msg.message_thread_id) } : {}),
                    text: String(callback?.data ?? msg.text ?? msg.caption ?? ""),
                    message_id: callback
                      ? `cb:${callback.id}`
                      : update.edited_message
                        ? `edit:${chat.id}:${msg.message_id}:${update.update_id}`
                        : `${chat.id}:${msg.message_id}`,
                    kind: callback ? "action" : "message",
                    ...(update.edited_message ? { event: "edit" as const } : {}),
                    is_direct: chat.type === "private",
                    ...(attachments.length ? { attachments } : {}),
                    ...(context ? { context } : {}),
                    is_mention:
                      !!botName &&
                      String(msg.text ?? msg.caption ?? "")
                        .toLowerCase()
                        .includes(`@${botName.toLowerCase()}`),
                  });
                } finally {
                  state?.saveCursor(String(offset));
                }
              }
            } catch (error) {
              if (stopped) break;
              failed(error instanceof ProviderFailure ? error.message : "polling_failed");
              if (error instanceof ProviderFailure && error.message.includes("409")) break;
              await Bun.sleep(3000);
            }
          }
        })();
      },
      async stop() {
        stopped = true;
        abort?.abort();
        await loop;
      },
    };
  },
};
