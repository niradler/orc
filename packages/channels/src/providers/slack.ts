import type { ChannelInbound } from "@orc/core/channels";
import { ValidationError } from "@orc/core/errors";
import { UPLOAD_MAX_BYTES, UPLOAD_MAX_FILES } from "@orc/core/session-file-types";
import {
  type ChannelAttachment,
  type ChannelProvider,
  downloadBounded,
  type NativePayload,
  ProviderFailure,
  postJson,
} from "./base.js";
import { type MarkdownMarks, renderText } from "./markdown.js";

const marks: MarkdownMarks = {
  strong: (t) => `*${t}*`,
  em: (t) => `_${t}_`,
  del: (t) => `~${t}~`,
  code: (t) => `\`${t}\``,
  pre: (t) => `\`\`\`\n${t}\n\`\`\`\n`,
  link: (url, t) => `<${url.replace(/[<>|]/g, encodeURIComponent)}|${t}>`,
  heading: (t) => `*${t}*`,
  quote: (t) =>
    `${t
      .split("\n")
      .map((line) => `&gt; ${line}`)
      .join("\n")}\n`,
};
const decodeEntities = (text: string) =>
  text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const label = (text: string) => Array.from(text).slice(0, 75).join("");
export const slackSection = (text: string, plain: boolean) => ({
  type: "section",
  text: plain
    ? { type: "plain_text", text: decodeEntities(text).slice(0, 3000) || " " }
    : { type: "mrkdwn", text: text.slice(0, 3000) || " " },
});

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
        "mpim:history",
        "channels:history",
        "groups:history",
        "app_mentions:read",
        "files:read",
        "users:read",
      ],
    },
  },
  settings: {
    socket_mode_enabled: true,
    interactivity: { is_enabled: true },
    event_subscriptions: {
      bot_events: [
        "message.im",
        "message.mpim",
        "message.channels",
        "message.groups",
        "app_mention",
      ],
    },
  },
};

async function call(
  token: string,
  method: string,
  payload: NativePayload = {},
): Promise<Record<string, unknown>> {
  const { status, body } = await postJson(
    `https://slack.com/api/${method}`,
    { Authorization: `Bearer ${token}` },
    payload,
  );
  if (status >= 400 || !body.ok)
    throw new ProviderFailure(
      typeof body.error === "string" && /^[a-z_]+$/.test(body.error)
        ? body.error
        : `http_${status}_code_0`,
      status >= 500,
    );
  return body;
}

export function slackFiles(event: Record<string, unknown>): ChannelAttachment[] {
  const files = Array.isArray(event.files) ? event.files : [];
  return files.slice(0, UPLOAD_MAX_FILES).flatMap((value: Record<string, unknown>) => {
    const url = value?.url_private_download;
    if (typeof url !== "string" || !url.startsWith("https://files.slack.com/")) return [];
    return [
      {
        fileId: url,
        name: String(value.name ?? value.title ?? "slack-file").slice(0, 255),
        mimeType: String(value.mimetype ?? "application/octet-stream").slice(0, 255),
        ...(typeof value.size === "number" ? { size: value.size } : {}),
        description: `Slack ${String(value.pretty_type ?? value.filetype ?? "file").slice(0, 100)}`,
      },
    ];
  });
}

type SlackEvent = {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  channel?: string;
  channel_type?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  files?: unknown;
};
type SlackEnvelope = {
  type?: string;
  envelope_id?: string;
  payload?: {
    team_id?: string;
    command?: string;
    text?: string;
    user?: { id?: string; username?: string; name?: string };
    user_id?: string;
    user_name?: string;
    channel?: { id?: string };
    channel_id?: string;
    actions?: Array<{ value?: string; action_id?: string }>;
    message?: { thread_ts?: string };
    event?: SlackEvent;
  };
};

export function slackInbound(
  envelope: SlackEnvelope,
  connection: string,
  botId: string,
): ChannelInbound | null {
  const payload = envelope.payload ?? {};
  const e = payload.event ?? {};
  const action = payload.actions?.[0];
  const slash = envelope.type === "slash_commands" && payload.command === "/orc";
  if (e.bot_id || (botId && e.user === botId)) return null;
  if (e.subtype && !["file_share", "thread_broadcast"].includes(e.subtype)) return null;
  const attachments = action || slash ? [] : slackFiles(e as Record<string, unknown>);
  if (!action && !slash && !e.text && !attachments.length) return null;
  const sender = String(payload.user?.id ?? payload.user_id ?? e.user ?? "");
  const chat = String(payload.channel?.id ?? payload.channel_id ?? e.channel ?? "");
  if (!sender || !chat) return null;
  const direct = e.channel_type === "im" || e.channel_type === "mpim" || chat.startsWith("D");
  const thread = e.thread_ts ?? payload.message?.thread_ts;
  const mention = botId ? `<@${botId}>` : "";
  const raw = String(action?.value ?? action?.action_id ?? e.text ?? "");
  return {
    connection,
    sender,
    sender_name: payload.user?.username ?? payload.user?.name ?? payload.user_name,
    chat,
    ...(thread ? { thread: String(thread) } : {}),
    ...(!action && !slash && e.ts ? { root: String(e.ts) } : {}),
    text: slash
      ? `/orc ${String(payload.text ?? "help")}`
      : (mention ? raw.replaceAll(mention, "") : raw).replace(/\s+/g, " ").trim(),
    message_id: action || slash ? String(envelope.envelope_id ?? "") : `${chat}:${e.ts}`,
    kind: action ? "action" : "message",
    is_direct: direct,
    is_mention: e.type === "app_mention" || (!!mention && raw.includes(mention)),
    ...(attachments.length ? { attachments } : {}),
  };
}

export const slack: ChannelProvider = {
  info: {
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
      files: true,
      native_overrides: true,
    },
    setup: [
      "Create a Slack app from the supplied manifest and install it into your workspace.",
      "Enable Socket Mode; create an app token with connections:write and supply the bot token.",
      "Verify the workspace, pair yourself from the app's Messages tab, then add channels or * for any DM.",
    ],
  },
  accountKey: "bot_token",
  replyControls: false,
  manifest: slackManifest,
  render(message) {
    const { chunks, plain, warnings } = renderText(
      message,
      marks,
      message.links.length ? 3000 : 30000,
    );
    if (message.links.some((link) => Array.from(link.label).length > 75))
      warnings.push(
        "Slack button labels shortened to 75 characters; link destinations are unchanged.",
      );
    const payloads: NativePayload[] = chunks.map((text) => ({
      text,
      mrkdwn: !plain,
      unfurl_links: false,
      unfurl_media: false,
    }));
    const last = payloads.at(-1);
    if (last && message.links.length)
      last.blocks = [
        slackSection(String(last.text), plain),
        {
          type: "actions",
          elements: message.links.map((link, i) => ({
            type: "button",
            action_id: `link-${i}`,
            text: { type: "plain_text", text: label(link.label) },
            url: link.url,
          })),
        },
      ];
    return { payloads, warnings };
  },
  destination: (chat, thread) => ({ channel: chat, ...(thread ? { thread_ts: thread } : {}) }),
  controls(text, format, rows) {
    const rendered = slack.render({ text: text || " ", format, links: [] }).payloads[0];
    return {
      blocks: [
        slackSection(String(rendered?.text ?? text), format === "plain"),
        ...rows.map((row, i) => ({
          type: "actions",
          block_id: `orc-controls-${i}`,
          elements: row.map((b) => ({
            type: "button",
            action_id: b.value,
            text: { type: "plain_text", text: label(b.label) },
            value: b.value,
          })),
        })),
      ],
    };
  },
  pairing: (identity, token) => ({
    url: `https://app.slack.com/client/${encodeURIComponent(identity.id)}`,
    message: `orc-pair ${token}`,
  }),
  transport(connection, credentials) {
    const token = credentials.bot_token;
    if (!token) throw new ValidationError("Missing channel bot token");
    let stopped = false;
    let socket: WebSocket | undefined;
    let loop: Promise<void> | undefined;
    let botId = "";
    let workspaceId = "";
    return {
      async downloadFile(file) {
        if (!file.fileId.startsWith("https://files.slack.com/"))
          throw new ProviderFailure("invalid_file_path");
        if (file.size !== undefined && file.size > UPLOAD_MAX_BYTES)
          throw new ValidationError("Slack files must be at most 20 MB");
        return downloadBounded(file.fileId, { Authorization: `Bearer ${token}` }, file, "Slack");
      },
      async identity() {
        const body = await call(token, "auth.test");
        botId = String(body.user_id ?? "");
        workspaceId = String(body.team_id ?? "");
        return { id: workspaceId, name: String(body.team ?? body.user ?? botId) };
      },
      async send(payload) {
        const result = await call(token, "chat.postMessage", payload);
        return String(result.ts);
      },
      async edit(id, payload) {
        await call(token, "chat.update", { ...payload, ts: id, blocks: payload.blocks ?? [] });
      },
      async start(receive, failed) {
        stopped = false;
        const startedAt = Date.now();
        const appToken = credentials.app_token;
        if (!appToken) throw new ValidationError("Slack Socket Mode requires an app token");
        if (!botId) await this.identity();
        const connect = async () => {
          const body = await call(appToken, "apps.connections.open");
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
              const message = slackInbound(envelope, connection.id, botId);
              if (!message) return;
              const ts = Number(payload.event?.ts);
              if (message.kind === "message" && ts && ts * 1000 < startedAt - 1000) return;
              receive(message);
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
      },
      async stop() {
        stopped = true;
        socket?.close();
        await loop;
      },
    };
  },
};
