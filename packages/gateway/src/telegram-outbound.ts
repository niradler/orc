import { type ChannelService, getChannelService } from "@orc/channels";
import type { ChannelTarget, ChannelView } from "@orc/core/channels";
import { loadConfig } from "@orc/core/config";
import { OrcError, ValidationError } from "@orc/core/errors";
import { getSqlite } from "@orc/db/client";
import { Bot } from "grammy";
import { redactSecrets } from "./redact.js";

const NIR = /^(nir|me)$/i;

export type TelegramRecipient = {
  name: string;
  chat_id: string;
  connection_id: string | null;
  target_id: string | null;
  project_ids: string[];
  enabled: boolean;
  outbound: boolean;
};

export type TelegramStatus = {
  ready: boolean;
  via: "channel" | "gateway" | null;
  recipient: TelegramRecipient | null;
  recipients: TelegramRecipient[];
  token_configured: boolean;
  setup: string | null;
};

export type TelegramSendResult = {
  via: "channel" | "gateway";
  status: "accepted";
  name: string;
  chat_id: string;
  connection_id: string | null;
  target_id: string | null;
  receipt_id: string | null;
  provider_ids: string[];
  message_id: number | null;
  warnings: string[];
};

type Row = { connection: ChannelView; target: ChannelTarget };
type BridgeChat = {
  chat_id: string;
  username: string | null;
  display_name: string | null;
  authorized: number;
};

const PAIR =
  "In Settings → Channels, save the bot token, enable the Telegram connection, then Pair my Telegram and confirm Nir as the me recipient.";
const GATEWAY =
  "Or set gateway.telegram.enabled, gateway.telegram.token (or ORC_TELEGRAM_TOKEN), and gateway.telegram.default_chat_id to Nir's chat.";
const PRIVATE = "Do not paste the bot token into a tool call, a prompt, or a log.";

function safeTelegramError(error: unknown, token?: string): string {
  let raw = error instanceof Error ? error.message : String(error);
  if (token) raw = raw.split(token).join("[redacted]");
  raw = raw.replace(/[0-9]{6,}:[A-Za-z0-9_-]{20,}/g, "[redacted]");
  raw = redactSecrets(raw).replace(/https?:\/\/\S+/g, "[url]");
  return raw.slice(0, 300);
}

function bridgeChats(): BridgeChat[] {
  return getSqlite()
    .query(
      "SELECT chat_id, username, display_name, authorized FROM bridge_chats WHERE platform = 'telegram'",
    )
    .all() as BridgeChat[];
}

function projectLabel(ids: string[]): string {
  return ids
    .map((id) => {
      const row = getSqlite()
        .query<{ name: string }, [string]>("SELECT name FROM projects WHERE id = ?")
        .get(id);
      return row?.name ?? id;
    })
    .join(", ");
}

function tokenReady(connection: ChannelView): boolean {
  return !!connection.credentials.token?.configured;
}

function allowed(target: ChannelTarget, projectId: string | null): boolean {
  return !target.project_ids.length || (!!projectId && target.project_ids.includes(projectId));
}

function sendable(row: Row, projectId: string | null): boolean {
  return (
    row.connection.enabled &&
    row.target.outbound &&
    tokenReady(row.connection) &&
    allowed(row.target, projectId)
  );
}

function matches(row: Row, chat: string): boolean {
  const trimmed = chat.trim();
  const lower = trimmed.toLowerCase();
  return (
    row.target.id.toLowerCase() === lower ||
    row.target.name.toLowerCase() === lower ||
    row.target.chat_id === trimmed ||
    `${row.connection.id}/${row.target.id}`.toLowerCase() === lower
  );
}

function rank(target: ChannelTarget): number {
  if (target.name.toLowerCase() === "nir") return 0;
  if (target.id.toLowerCase() === "me" || NIR.test(target.name)) return 1;
  return 2;
}

function recipient(row: Row, outbound = row.target.outbound): TelegramRecipient {
  return {
    name: row.target.name,
    chat_id: row.target.chat_id,
    connection_id: row.connection.id,
    target_id: row.target.id,
    project_ids: row.target.project_ids,
    enabled: row.connection.enabled,
    outbound,
  };
}

function listLabel(rows: Row[]): string {
  return rows.map((row) => `${row.connection.id}/${row.target.id} (${row.target.name})`).join(", ");
}

function gatewayRecipients(): TelegramRecipient[] {
  const telegram = loadConfig().gateway.telegram;
  const found: TelegramRecipient[] = [];
  const push = (chatId: string, name: string) => {
    if (!chatId || found.some((item) => item.chat_id === chatId)) return;
    found.push({
      name,
      chat_id: chatId,
      connection_id: null,
      target_id: null,
      project_ids: [],
      enabled: telegram.enabled,
      outbound: true,
    });
  };
  if (telegram.default_chat_id) push(telegram.default_chat_id, "configured chat");
  for (const chat of bridgeChats()) {
    if (!chat.authorized) continue;
    push(chat.chat_id, chat.display_name || chat.username || "authorized chat");
  }
  for (const user of telegram.authorized_users) push(String(user), "authorized user");
  return found;
}

function resolveGatewayChat(
  requested: string | undefined,
  known: TelegramRecipient[],
): { chatId: string; name: string } | null {
  if (requested) {
    const trimmed = requested.trim();
    const hit = known.find(
      (item) => item.chat_id === trimmed || item.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (!hit)
      throw new ValidationError(
        `No configured Telegram chat matches "${trimmed}". telegram_status lists the chats this tool can use. ${PRIVATE}`,
      );
    return { chatId: hit.chat_id, name: hit.name };
  }
  const telegram = loadConfig().gateway.telegram;
  if (telegram.default_chat_id)
    return { chatId: telegram.default_chat_id, name: "configured chat" };
  const bridges = bridgeChats().filter((chat) => chat.authorized);
  const nir = bridges.find((chat) =>
    [chat.display_name, chat.username].some((value) => value?.toLowerCase() === "nir"),
  );
  if (nir) return { chatId: nir.chat_id, name: nir.display_name || nir.username || "Nir" };
  if (bridges.length === 1) {
    const only = bridges[0];
    if (only) return { chatId: only.chat_id, name: only.display_name || only.username || "Nir" };
  }
  if (telegram.authorized_users.length === 1 && bridges.length === 0) {
    const only = telegram.authorized_users[0];
    if (only !== undefined) return { chatId: String(only), name: "authorized user" };
  }
  if (known.length > 1)
    throw new ValidationError(
      `More than one Telegram chat is configured. Pass chat as one of: ${known
        .map((item) => `${item.chat_id} (${item.name})`)
        .join(", ")}.`,
    );
  return null;
}

function channelSetup(rows: Row[], projectId: string | null): string {
  const enabled = rows.filter((row) => row.connection.enabled);
  const blocked = enabled.filter(
    (row) => row.target.outbound && tokenReady(row.connection) && !allowed(row.target, projectId),
  );
  if (blocked.length) {
    const projects = [...new Set(blocked.flatMap((row) => row.target.project_ids))];
    return `Nir's Telegram recipient is limited to project ${projectLabel(projects)}. Pass that project.`;
  }
  if (enabled.some((row) => !tokenReady(row.connection)))
    return `The Telegram connection has no bot token. ${PAIR} ${PRIVATE}`;
  if (enabled.length && enabled.every((row) => !row.target.outbound))
    return "Outbound messaging is disabled for the Telegram recipient. Enable it in Settings → Channels.";
  if (enabled.some((row) => row.connection.targets.length === 0))
    return `The Telegram connection has no recipient. ${PAIR}`;
  return `${PAIR} ${GATEWAY} ${PRIVATE}`;
}

function rowsOf(service: ChannelService): Row[] {
  return service
    .list()
    .filter((connection) => connection.provider === "telegram")
    .flatMap((connection) => connection.targets.map((target) => ({ connection, target })));
}

function chooseChannel(
  rows: Row[],
  projectId: string | null,
  chat: string | undefined,
): { ok: true; row: Row } | { ok: false; setup: string } | null {
  const enabled = rows.filter((row) => row.connection.enabled);
  if (!enabled.length) return null;
  const ready = rows.filter((row) => sendable(row, projectId));
  if (!chat) {
    const preferred = enabled.filter((row) => rank(row.target) < 2);
    if (preferred.length) {
      const usable = preferred.filter((row) => sendable(row, projectId));
      if (usable.length === 1) {
        const row = usable[0];
        return row ? { ok: true, row } : { ok: false, setup: channelSetup(rows, projectId) };
      }
      if (usable.length > 1) {
        const best = Math.min(...usable.map((row) => rank(row.target)));
        const top = usable.filter((row) => rank(row.target) === best);
        if (top.length === 1) {
          const row = top[0];
          return row ? { ok: true, row } : { ok: false, setup: channelSetup(rows, projectId) };
        }
        return {
          ok: false,
          setup: `More than one Telegram recipient is configured for Nir. Pass chat as one of: ${listLabel(top)}.`,
        };
      }
      return { ok: false, setup: channelSetup(preferred, projectId) };
    }
  }
  if (chat) {
    const matched = rows.filter((row) => matches(row, chat));
    if (!matched.length)
      return {
        ok: false,
        setup: `No Telegram recipient matches "${chat.trim()}". telegram_status lists the recipients this tool can use.`,
      };
    const usable = matched.filter((row) => sendable(row, projectId));
    if (usable.length === 1) {
      const row = usable[0];
      return row ? { ok: true, row } : { ok: false, setup: channelSetup(rows, projectId) };
    }
    if (usable.length > 1)
      return {
        ok: false,
        setup: `More than one Telegram recipient matches "${chat.trim()}". Pass chat as one of: ${listLabel(usable)}.`,
      };
    return { ok: false, setup: channelSetup(matched, projectId) };
  }
  if (ready.length === 1) {
    const row = ready[0];
    return row ? { ok: true, row } : { ok: false, setup: channelSetup(rows, projectId) };
  }
  if (ready.length > 1)
    return {
      ok: false,
      setup: `More than one Telegram recipient is configured. Pass chat as one of: ${listLabel(ready)}.`,
    };
  return { ok: false, setup: channelSetup(rows, projectId) };
}

function inspect(input: { projectId?: string | null; chat?: string } = {}): TelegramStatus {
  const projectId = input.projectId ?? null;
  const service = getChannelService();
  const rows = rowsOf(service);
  const gatewayKnown = gatewayRecipients();
  const recipients = [
    ...rows.map((row) => recipient(row)),
    ...gatewayKnown.filter((item) => !rows.some((row) => row.target.chat_id === item.chat_id)),
  ];
  const telegram = loadConfig().gateway.telegram;
  const tokenConfigured =
    tokenSet(telegram.token) || rows.some((row) => tokenReady(row.connection));
  const chosen = chooseChannel(rows, projectId, input.chat);
  if (chosen?.ok) {
    return {
      ready: true,
      via: "channel",
      recipient: recipient(chosen.row),
      recipients,
      token_configured: tokenConfigured,
      setup: null,
    };
  }
  if (chosen && !chosen.ok) {
    return {
      ready: false,
      via: null,
      recipient: null,
      recipients,
      token_configured: tokenConfigured,
      setup: chosen.setup,
    };
  }
  if (telegram.enabled && tokenSet(telegram.token)) {
    try {
      const chat = resolveGatewayChat(input.chat, gatewayKnown);
      if (chat)
        return {
          ready: true,
          via: "gateway",
          recipient: {
            name: chat.name,
            chat_id: chat.chatId,
            connection_id: null,
            target_id: null,
            project_ids: [],
            enabled: true,
            outbound: true,
          },
          recipients,
          token_configured: true,
          setup: null,
        };
      return {
        ready: false,
        via: null,
        recipient: null,
        recipients,
        token_configured: true,
        setup: `Telegram token is configured, but Nir's chat is not. Set gateway.telegram.default_chat_id, or ${PAIR} ${PRIVATE}`,
      };
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return {
        ready: false,
        via: null,
        recipient: null,
        recipients,
        token_configured: true,
        setup: error.message,
      };
    }
  }
  const disabled = [...new Set(rows.map((row) => row.connection.id))];
  const setup = disabled.length
    ? `Telegram connection ${disabled.join(", ")} is disabled. Enable it in Settings → Channels. ${PAIR} ${PRIVATE}`
    : `${PAIR} ${GATEWAY} ${PRIVATE}`;
  return {
    ready: false,
    via: null,
    recipient: null,
    recipients,
    token_configured: tokenConfigured,
    setup,
  };
}

function tokenSet(value: string | undefined): boolean {
  return !!value?.trim();
}

export function telegramStatus(
  input: { projectId?: string | null; chat?: string } = {},
): TelegramStatus {
  return inspect(input);
}

async function deliverGatewayMessage(
  token: string,
  chatId: string,
  text: string,
): Promise<{ chat_id: string; message_id: number }> {
  // sendMessage only. bot.start() would open a second poller beside Channels or the gateway adapter.
  const bot = new Bot(token, { client: { fetch: globalThis.fetch, timeoutSeconds: 15 } });
  try {
    const sent = await bot.api.sendMessage(chatId, text.slice(0, 4096));
    return { chat_id: String(sent.chat.id), message_id: sent.message_id };
  } catch (error) {
    throw new OrcError(
      `Telegram did not accept the message (${safeTelegramError(error, token)}). Confirm gateway.telegram.default_chat_id is Nir's chat and that this bot may message it.`,
      "TELEGRAM_DELIVERY",
      502,
    );
  }
}

export async function sendTelegramToNir(input: {
  text: string;
  chat?: string;
  projectId?: string | null;
  idempotencyKey?: string;
}): Promise<TelegramSendResult> {
  const text = input.text.trim();
  if (!text) throw new ValidationError("Message text is empty.");
  if (text.length > 4096)
    throw new ValidationError(
      "This tool sends one Telegram message of at most 4096 characters. Shorten it, or use channel_send for a longer message.",
    );
  const projectId = input.projectId ?? null;
  const status = inspect({ projectId, ...(input.chat ? { chat: input.chat } : {}) });
  if (!status.ready || !status.recipient || !status.via)
    throw new ValidationError(status.setup ?? `${PAIR} ${GATEWAY} ${PRIVATE}`);
  if (status.via === "channel") {
    const connection = status.recipient.connection_id;
    const target = status.recipient.target_id;
    if (!connection || !target) throw new ValidationError(status.setup ?? `${PAIR} ${PRIVATE}`);
    let receipt: Awaited<ReturnType<ChannelService["send"]>>;
    try {
      receipt = await getChannelService().send({
        connection,
        target,
        message: { text, format: "plain" },
        ...(projectId ? { project_id: projectId } : {}),
        ...(input.idempotencyKey ? { idempotency_key: input.idempotencyKey } : {}),
      });
    } catch (error) {
      if (error instanceof OrcError) throw error;
      throw new OrcError(
        `Telegram did not accept the message (${safeTelegramError(error)}). ${PAIR} ${PRIVATE}`,
        "TELEGRAM_DELIVERY",
        502,
      );
    }
    if (receipt.status !== "accepted")
      throw new OrcError(
        `Telegram did not accept the message (${receipt.status}: ${safeTelegramError(receipt.error ?? "delivery failed")}). Check Settings → Channels before retrying the same idempotency key.`,
        "TELEGRAM_DELIVERY",
        502,
      );
    return {
      via: "channel",
      status: "accepted",
      name: status.recipient.name,
      chat_id: status.recipient.chat_id,
      connection_id: connection,
      target_id: target,
      receipt_id: receipt.id,
      provider_ids: receipt.provider_ids,
      message_id: null,
      warnings: receipt.warnings,
    };
  }
  const token = loadConfig().gateway.telegram.token?.trim();
  if (!token)
    throw new ValidationError(`Telegram token is not configured. ${PAIR} ${GATEWAY} ${PRIVATE}`);
  const sent = await deliverGatewayMessage(token, status.recipient.chat_id, text);
  return {
    via: "gateway",
    status: "accepted",
    name: status.recipient.name,
    chat_id: sent.chat_id,
    connection_id: null,
    target_id: null,
    receipt_id: null,
    provider_ids: [],
    message_id: sent.message_id,
    warnings: [],
  };
}
