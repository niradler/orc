import { type InboundMessage, listen, type Transport } from "@niradler55/earshot";
import type { ChannelInbound } from "@orc/core/channels";
import { ValidationError } from "@orc/core/errors";
import { type ChannelProvider, type NativePayload, ProviderFailure, postJson } from "./base.js";
import { slack, slackSection } from "./slack.js";

const TRANSPORTS: string[] = ["auto", "rtm", "gateway"];

async function call(
  token: string,
  cookie: string,
  method: string,
  payload: NativePayload = {},
): Promise<Record<string, unknown>> {
  const { status, body } = await postJson(
    `https://slack.com/api/${method}`,
    { Authorization: `Bearer ${token}`, Cookie: `d=${cookie}` },
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

/** Maps an earshot message to the shared inbound shape; the session user's own
 * messages stay inbound (they are the trigger) — only posted ts are loop-guarded. */
export function slackUserInbound(
  message: InboundMessage,
  connection: string,
  selfId: string,
  selfName: string,
): ChannelInbound | null {
  if (!message.user || !message.channel || !message.ts) return null;
  const raw = message.text;
  const mention = selfId ? `<@${selfId}>` : "";
  const text = (mention ? raw.replaceAll(mention, "") : raw).replace(/\s+/g, " ").trim();
  if (!text) return null;
  const direct =
    message.channel_type === "im" ||
    message.channel_type === "mpim" ||
    message.channel.startsWith("D");
  return {
    connection,
    sender: message.user,
    ...(message.user === selfId && selfName ? { sender_name: selfName } : {}),
    chat: message.channel,
    ...(message.thread_ts ? { thread: message.thread_ts } : {}),
    root: message.ts,
    text,
    message_id: `${message.channel}:${message.ts}`,
    kind: "message",
    is_direct: direct,
    is_mention: /^@orc\b/i.test(raw.trim()) || (!!mention && raw.includes(mention)),
  };
}

export const slackUser: ChannelProvider = {
  info: {
    id: "slack-user",
    name: "Slack (user session)",
    credentials: [
      { key: "token", label: "User token (xoxc)", env: "ORC_SLACK_USER_TOKEN" },
      { key: "cookie", label: "Session cookie (d)", env: "ORC_SLACK_USER_COOKIE" },
    ],
    documentation: "https://github.com/niradler/earshot",
    capabilities: {
      markdown: true,
      links: true,
      // A user session has no app to receive button interactions; controls are
      // rendered as typeable commands instead.
      buttons: false,
      edit: true,
      threads: true,
      files: false,
      native_overrides: true,
    },
    setup: [
      "Sign in to Slack in your browser. Copy the xoxc token (DevTools console: TS.boot_data.api_token) and the d cookie (DevTools → Application → Cookies), or run `bunx @niradler55/earshot token` on macOS.",
      "Paste both below. ORC connects as you over your own session — no Slack app or admin approval; replies post as you. Treat the cookie like a password.",
      "Pair yourself from your own Slack DM, add an inbound route (for example text starts with @orc), then type @orc <message> in any thread.",
    ],
  },
  accountKey: "token",
  replyControls: false,
  render: (message) => slack.render(message),
  destination: (chat, thread) => slack.destination(chat, thread),
  controls(text, format, rows) {
    const rendered = slack.render({ text: text || " ", format, links: [] }).payloads[0];
    const commands = rows
      .flat()
      .filter((button) => !button.value.startsWith("orc_action:"))
      .map((button) =>
        format === "plain"
          ? `${button.label}: ${button.value}`
          : `${button.label}: \`${button.value}\``,
      );
    const body = [String(rendered?.text ?? text), ...commands].join("\n");
    return { blocks: [slackSection(body, format === "plain")] };
  },
  pairing: (identity, token) => slack.pairing(identity, token),
  transport(connection, credentials) {
    const token = credentials.token?.trim();
    const cookie = credentials.cookie?.trim().replace(/^d=/, "");
    if (!token) throw new ValidationError("Missing Slack user token (xoxc)");
    if (!cookie) throw new ValidationError("Missing Slack session cookie (d)");
    const configured = connection.config.transport ?? "auto";
    if (typeof configured !== "string" || !TRANSPORTS.includes(configured))
      throw new ValidationError("config.transport must be auto, rtm or gateway");
    const transport = configured as Transport;
    let gateway: { stop: () => void } | undefined;
    let selfId = "";
    let selfName = "";
    let startedAt = 0;
    // Replies post as the user and return on the same socket; drop their echoes.
    const posted = new Set<string>();
    const remember = (ts: string) => {
      posted.add(ts);
      if (posted.size > 1000) posted.delete(posted.values().next().value as string);
    };
    return {
      async identity() {
        const body = await call(token, cookie, "auth.test");
        selfId = String(body.user_id ?? "");
        selfName = String(body.user ?? "");
        return { id: String(body.team_id ?? ""), name: String(body.team ?? body.user ?? selfId) };
      },
      async send(payload) {
        const result = await call(token, cookie, "chat.postMessage", payload);
        const ts = String(result.ts);
        remember(ts);
        return ts;
      },
      async edit(id, payload) {
        await call(token, cookie, "chat.update", {
          ...payload,
          ts: id,
          blocks: payload.blocks ?? [],
        });
      },
      async start(receive, failed) {
        if (!selfId) await this.identity();
        startedAt = Date.now();
        gateway = listen({
          token,
          cookie,
          transport,
          onMessage: (message) => {
            if (posted.has(message.ts)) return;
            const ts = Number(message.ts);
            if (ts && ts * 1000 < startedAt - 1000) return;
            const inbound = slackUserInbound(message, connection.id, selfId, selfName);
            if (inbound) receive(inbound);
          },
          onStatus: (status, detail) => {
            if (status === "connected") failed("");
            else if (status === "auth_failed")
              failed(
                `session_expired: Slack rejected this user session (${String(detail)}). Paste a fresh token and cookie, then save the connection.`,
              );
            else if (status === "connect_failed" || status === "reconnecting")
              failed("socket_disconnected");
          },
        });
      },
      async stop() {
        gateway?.stop();
        gateway = undefined;
      },
    };
  },
};
