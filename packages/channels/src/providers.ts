import {
  ChannelBuiltinCommands,
  type ChannelConnection,
  type ChannelInbound,
  channelCommands,
} from "@orc/core/channels";
import { OrcError, ValidationError } from "@orc/core/errors";

export type NativePayload = Record<string, unknown>;
export type ProviderIdentity = { id: string; name: string };
export type ChannelTransport = {
  identity(): Promise<ProviderIdentity>;
  send(payload: NativePayload): Promise<string>;
  edit(id: string, payload: NativePayload): Promise<void>;
  start(receive: (message: ChannelInbound) => void, failed: (code: string) => void): Promise<void>;
  stop(): Promise<void>;
};
export type TransportState = { loadCursor(): string | undefined; saveCursor(cursor: string): void };
export type TransportFactory = (
  connection: ChannelConnection,
  credentials: Record<string, string>,
  state?: TransportState,
) => ChannelTransport;

export const channelProviders = [
  {
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
      native_overrides: true,
    },
    setup: [
      "Create a bot with @BotFather, or use the configured token.",
      "Verify bot identity, then open a pairing link in your private chat.",
      "Confirm your identity in ORC, choose inbound routes, and send a test.",
    ],
  },
  {
    id: "slack",
    name: "Slack",
    credentials: [
      { key: "bot_token", label: "Bot token", env: "ORC_SLACK_BOT_TOKEN" },
      { key: "app_token", label: "Socket Mode app token", env: "ORC_SLACK_APP_TOKEN" },
    ],
    documentation: "https://docs.slack.dev/reference/methods/chat.postMessage/",
    capabilities: {
      markdown: true,
      links: true,
      buttons: true,
      edit: true,
      threads: true,
      native_overrides: true,
    },
    setup: [
      "Create a Slack app from the supplied manifest and install it into your workspace.",
      "Enable Socket Mode; create an app token with connections:write and supply the bot token.",
      "Verify the workspace, add approved DM/channel IDs and sender IDs, then test.",
    ],
  },
] as const;

export const slackManifest = {
  display_information: { name: "ORC", description: "ORC agent communication" },
  features: {
    slash_commands: [
      {
        command: "/orc",
        description: "ORC commands and agent shortcuts",
        usage_hint: "help | status | <shortcut> [arguments]",
        should_escape: false,
      },
    ],
    bot_user: { display_name: "ORC", always_online: false },
    app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
  },
  oauth_config: {
    scopes: {
      bot: [
        "commands",
        "chat:write",
        "im:write",
        "im:history",
        "channels:history",
        "groups:history",
        "app_mentions:read",
      ],
    },
  },
  settings: {
    socket_mode_enabled: true,
    interactivity: { is_enabled: true },
    event_subscriptions: {
      bot_events: ["message.im", "message.channels", "message.groups", "app_mention"],
    },
  },
};

// Provider errors are reduced to safe machine codes. URLs may contain bot credentials.
export class ProviderFailure extends OrcError {
  constructor(
    code: string,
    readonly ambiguous = false,
  ) {
    super(`Channel provider: ${code}`, "CHANNEL_PROVIDER_ERROR", 502);
  }
}

export function safeProviderCode(value: string): string {
  const code = value.replace(/^Channel provider: /, "");
  if (/^http_[1-5][0-9]{2}_code_[0-9]{1,3}$/.test(code)) return code;
  const known = new Set([
    "rate_limited",
    "invalid_response",
    "network_or_timeout",
    "webhook_already_owned",
    "invalid_socket_url",
    "socket_connect_timeout",
    "socket_connect_failed",
    "socket_disconnected",
    "polling_failed",
    "invalid_auth",
    "not_authed",
    "token_revoked",
    "account_inactive",
    "missing_scope",
    "channel_not_found",
    "not_in_channel",
    "restricted_action",
  ]);
  return known.has(code) ? code : "provider_failure";
}
async function request(
  provider: string,
  token: string,
  method: string,
  payload: NativePayload = {},
  signal?: AbortSignal,
  retry = 0,
): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(
      provider === "telegram"
        ? `https://api.telegram.org/bot${token}/${method}`
        : `https://slack.com/api/${method}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(provider === "slack" ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: signal ?? AbortSignal.timeout(15000),
        redirect: "error",
      },
    );
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.status === 429 || Number(body.error_code) === 429) {
      const parameters = body.parameters as { retry_after?: number } | undefined;
      const seconds = Number(response.headers.get("retry-after") ?? parameters?.retry_after ?? 1);
      if (retry < 2 && Number.isFinite(seconds) && seconds >= 0 && seconds <= 30) {
        await Bun.sleep(Math.max(250, seconds * 1000));
        return request(provider, token, method, payload, signal, retry + 1);
      }
      throw new ProviderFailure("rate_limited");
    }
    if (response.ok && !Object.hasOwn(body, "ok"))
      throw new ProviderFailure("invalid_response", true);
    if (
      method === "editMessageText" &&
      Number(body.error_code) === 400 &&
      String(body.description).includes("message is not modified")
    )
      return {};
    if (!response.ok || !body.ok) {
      const code =
        provider === "slack" && typeof body.error === "string" && /^[a-z_]+$/.test(body.error)
          ? body.error
          : `http_${response.status}_code_${Number(body.error_code) || 0}`;
      throw new ProviderFailure(code, response.status >= 500);
    }
    return provider === "telegram" ? (body.result as Record<string, unknown>) : body;
  } catch (error) {
    if (error instanceof ProviderFailure) throw error;
    throw new ProviderFailure("network_or_timeout", true);
  }
}

export const createChannelTransport: TransportFactory = (connection, credentials, state) => {
  let stopped = false;
  let abort: AbortController | undefined;
  let socket: WebSocket | undefined;
  let botId = "";
  let botName = "";
  let workspaceId = "";
  let loop: Promise<void> | undefined;
  const provider = connection.provider;
  const token = credentials[provider === "telegram" ? "token" : "bot_token"];
  if (!token) throw new ValidationError("Missing channel bot token");
  const call = (method: string, body?: NativePayload) => request(provider, token, method, body);
  return {
    async identity() {
      const body = await call(provider === "telegram" ? "getMe" : "auth.test");
      botId = String(body.id ?? body.user_id ?? "");
      botName = String(body.username ?? "");
      workspaceId = String(body.team_id ?? "");
      return {
        id: provider === "telegram" ? botId : String(body.team_id),
        name: String(body.username ?? body.team ?? body.user ?? botId),
      };
    },
    async send(payload) {
      const result = await call(
        provider === "telegram" ? "sendMessage" : "chat.postMessage",
        payload,
      );
      return String(result.message_id ?? result.ts);
    },
    async edit(id, payload) {
      await call(provider === "telegram" ? "editMessageText" : "chat.update", {
        ...payload,
        ...(provider === "telegram"
          ? {
              message_id: Number(id),
              reply_markup: payload.reply_markup ?? { inline_keyboard: [] },
            }
          : { ts: id, blocks: payload.blocks ?? [] }),
      });
    },
    async start(receive, failed) {
      stopped = false;
      const startedAt = Date.now();
      if (provider === "telegram") {
        const info = await call("getWebhookInfo");
        if (info.url) throw new ProviderFailure("webhook_already_owned");
        await call("setMyCommands", {
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
              const result = (await request(
                provider,
                token,
                "getUpdates",
                { offset, timeout: 25, allowed_updates: ["message", "callback_query"] },
                AbortSignal.any([abort.signal, AbortSignal.timeout(35000)]),
              )) as unknown as Array<Record<string, unknown>>;
              failed("");
              for (const update of result) {
                offset = Number(update.update_id) + 1;
                try {
                  const callback = update.callback_query as Record<string, unknown> | undefined;
                  const msg = (update.message ?? callback?.message) as
                    | Record<string, unknown>
                    | undefined;
                  const from = (callback?.from ?? msg?.from) as Record<string, unknown> | undefined;
                  const chat = msg?.chat as Record<string, unknown> | undefined;
                  if (!msg || !from || !chat || from.is_bot) continue;
                  if (!resumeCursor && !callback && Number(msg.date) * 1000 < startedAt - 1000)
                    continue;
                  if (callback)
                    void call("answerCallbackQuery", { callback_query_id: callback.id }).catch(
                      () => {},
                    );
                  receive({
                    connection: connection.id,
                    sender: String(from.id),
                    chat: String(chat.id),
                    ...(msg.message_thread_id ? { thread: String(msg.message_thread_id) } : {}),
                    text: String(callback?.data ?? msg.text ?? msg.caption ?? ""),
                    message_id: callback ? `cb:${callback.id}` : `${chat.id}:${msg.message_id}`,
                    kind: callback ? "action" : "message",
                    is_direct: chat.type === "private",
                    is_mention:
                      !!botName &&
                      String(msg.text ?? "")
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
      } else {
        const appToken = credentials.app_token;
        if (!appToken) throw new ValidationError("Slack Socket Mode requires an app token");
        const connect = async () => {
          const body = await request("slack", appToken, "apps.connections.open");
          if (typeof body.url !== "string" || !body.url.startsWith("wss://"))
            throw new ProviderFailure("invalid_socket_url");
          const active = new WebSocket(body.url);
          socket = active;
          let resolveConnected: () => void = () => {};
          let rejectConnected: (error: Error) => void = () => {};
          const connected = new Promise<void>((resolve, reject) => {
            resolveConnected = resolve;
            rejectConnected = reject;
          });
          const timeout = setTimeout(() => {
            rejectConnected(new ProviderFailure("socket_connect_timeout"));
            active.close();
          }, 15000);
          timeout.unref();
          active.onopen = () => {
            clearTimeout(timeout);
            failed("");
            resolveConnected();
          };
          active.onmessage = (event) => {
            try {
              const envelope = JSON.parse(String(event.data));
              if (envelope.type === "disconnect") {
                active.close();
                return;
              }
              if (envelope.envelope_id)
                active.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
              const payload = envelope.payload ?? {};
              const eventWorkspace = String(payload.team_id ?? payload.team?.id ?? "");
              if (workspaceId && eventWorkspace && workspaceId !== eventWorkspace) {
                failed(
                  "workspace_mismatch: bot and app tokens must belong to the same Slack workspace",
                );
                return;
              }
              const e = payload.event ?? {};
              const action = payload.actions?.[0];
              const slash = envelope.type === "slash_commands" && payload.command === "/orc";
              if (e.bot_id || e.user === botId || e.subtype || (!action && !e.text && !slash))
                return;
              const sender = String(payload.user?.id ?? payload.user_id ?? e.user ?? "");
              const chat = String(payload.channel?.id ?? payload.channel_id ?? e.channel ?? "");
              if (!sender || !chat) return;
              if (!action && !slash && Number(e.ts) * 1000 < startedAt - 1000) return;
              const direct = e.channel_type === "im" || chat.startsWith("D");
              const thread =
                e.thread_ts ??
                payload.message?.thread_ts ??
                (direct ? undefined : (e.ts ?? payload.message?.ts));
              receive({
                connection: connection.id,
                sender,
                chat,
                ...(thread ? { thread: String(thread) } : {}),
                text: slash
                  ? `/orc ${String(payload.text ?? "help")}`
                  : String(action?.value ?? action?.action_id ?? e.text ?? "").replace(
                      new RegExp(`^<@${botId}>\\s*`),
                      "",
                    ),
                message_id:
                  action || slash ? String(envelope.envelope_id ?? "") : `${chat}:${e.ts}`,
                kind: action ? "action" : "message",
                is_direct: direct,
                is_mention: e.type === "app_mention" || String(e.text).includes(`<@${botId}>`),
              });
            } catch {
              failed("invalid_socket_event");
            }
          };
          active.onerror = () => {
            clearTimeout(timeout);
            failed("socket_error");
            rejectConnected(new ProviderFailure("socket_connect_failed"));
          };
          active.onclose = () => {
            clearTimeout(timeout);
            rejectConnected(new ProviderFailure("socket_disconnected"));
            if (!stopped && socket === active) {
              failed("socket_disconnected");
              loop = (async () => {
                while (!stopped && socket === active) {
                  await Bun.sleep(3000);
                  if (stopped) break;
                  try {
                    await connect();
                    break;
                  } catch {
                    failed("socket_reconnect_failed");
                  }
                }
              })();
            }
          };
          await connected;
        };
        await connect();
      }
    },
    async stop() {
      stopped = true;
      abort?.abort();
      socket?.close();
      await loop;
    },
  };
};
