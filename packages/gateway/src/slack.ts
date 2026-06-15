import { loadConfig } from "@orc/core/config";
import { createLogger } from "@orc/core/logger";
import { registerAdapter } from "./adapter-registry.js";
import type {
  GatewayAdapter,
  IncomingMessage,
  SupportsInlineButtons,
  SupportsMessageUpdate,
} from "./types.js";

const logger = createLogger("gateway:slack");

type SlackEnvelope = {
  envelope_id?: string;
  type?: string;
  payload?: Record<string, unknown>;
};

type SlackAdapter = GatewayAdapter & SupportsMessageUpdate & SupportsInlineButtons;

const DEDUP_TTL_MS = 60_000;

export function createSlackAdapter(startTime: number): SlackAdapter {
  const config = loadConfig();
  const botToken = config.gateway.slack.bot_token;
  const appToken = config.gateway.slack.app_token;
  if (!botToken || !appToken) throw new Error("Slack bot_token and app_token are required.");

  let socket: WebSocket | null = null;
  let listener: ((message: IncomingMessage) => Promise<void>) | null = null;
  let shouldRun = false;
  // Monotonic counter so a stale socket's late 'close' event can't trigger a
  // reconnect after a newer socket has already replaced it (prevents stacked
  // reconnect chains accumulating orphaned sockets/listeners over time).
  let socketGeneration = 0;
  const seenIds = new Map<string, number>();

  function isAuthorized(userId: string): boolean {
    const allowed = config.gateway.slack.authorized_users.map(String);
    return allowed.length > 0 && allowed.includes(userId);
  }

  function dedup(id: string): boolean {
    const now = Date.now();
    if (seenIds.has(id)) return true;
    seenIds.set(id, now);
    for (const [k, ts] of seenIds) {
      if (now - ts > DEDUP_TTL_MS) seenIds.delete(k);
    }
    return false;
  }

  function isTooOld(ts: string | undefined): boolean {
    if (!ts) return false;
    return parseFloat(ts) * 1000 < startTime;
  }

  async function openSocket(): Promise<WebSocket> {
    const response = await fetch("https://slack.com/api/apps.connections.open", {
      method: "POST",
      headers: { Authorization: `Bearer ${appToken}` },
    });
    const body = (await response.json()) as { ok?: boolean; url?: string; error?: string };
    if (!response.ok || !body.ok || !body.url) {
      throw new Error(body.error ?? `Slack socket connect failed (${response.status})`);
    }
    return new WebSocket(body.url);
  }

  async function ack(envelopeId?: string): Promise<void> {
    if (!socket || !envelopeId || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ envelope_id: envelopeId }));
  }

  async function handleEnvelope(raw: MessageEvent<string>): Promise<void> {
    const parsed = JSON.parse(raw.data) as SlackEnvelope;
    await ack(parsed.envelope_id);
    if (!listener) return;

    if (parsed.type === "interactive") {
      const payload = (parsed.payload ?? {}) as {
        user?: { id?: string; username?: string; name?: string };
        channel?: { id?: string };
        message?: { ts?: string };
        actions?: Array<{ value?: string }>;
      };
      const action = payload.actions?.[0]?.value;
      const userId = payload.user?.id;
      const channelId = payload.channel?.id;
      if (!action || !userId || !channelId || !isAuthorized(userId)) return;
      await listener({
        platform: "slack",
        chatId: channelId,
        userId,
        username: payload.user?.username,
        displayName: payload.user?.name,
        text: action,
        threadId: payload.message?.ts,
      });
      return;
    }

    const payload = (parsed.payload ?? {}) as {
      event?: {
        type?: string;
        user?: string;
        text?: string;
        channel?: string;
        ts?: string;
        channel_type?: string;
        thread_ts?: string;
        files?: Array<{ mimetype?: string; url_private_download?: string }>;
      };
    };
    const event = payload.event;
    if (!event?.type || !event.user || !event.channel) return;
    if (!isAuthorized(event.user)) return;
    if (event.type !== "app_mention" && !(event.type === "message" && event.channel_type === "im"))
      return;
    if (event.ts && dedup(event.ts)) return;
    if (isTooOld(event.ts)) return;

    const attachments: IncomingMessage["attachments"] = [];
    for (const file of event.files ?? []) {
      if (!file.url_private_download || !file.mimetype?.startsWith("audio/")) continue;
      try {
        const resp = await fetch(file.url_private_download, {
          headers: { Authorization: `Bearer ${botToken}` },
        });
        attachments.push({
          kind: "audio",
          data: new Uint8Array(await resp.arrayBuffer()),
          mimeType: file.mimetype,
          format: file.mimetype.split("/").at(1) ?? "mp3",
        });
      } catch {
        // skip bad file
      }
    }

    const text = (event.text ?? "").replace(/^<@[^>]+>\s*/, "").trim();
    await listener({
      platform: "slack",
      chatId: event.channel,
      userId: event.user,
      text,
      threadId: event.thread_ts ?? event.ts,
      platformMessageId: event.ts,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
  }

  async function post(
    url: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(`https://slack.com/api/${url}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok || body.ok !== true) {
      throw new Error(String(body.error ?? `Slack request failed (${response.status})`));
    }
    return body;
  }

  function buildBlocks(
    text: string,
    buttons?: Array<Array<{ label: string; value: string }>>,
  ): unknown[] | undefined {
    if (!buttons?.length) return undefined;
    return [
      { type: "section", text: { type: "mrkdwn", text } },
      {
        type: "actions",
        elements: buttons.flat().map((b) => ({
          type: "button",
          text: { type: "plain_text", text: b.label },
          value: b.value,
          action_id: b.value,
        })),
      },
    ];
  }

  return {
    platform: "slack",

    async start(onMessage) {
      listener = onMessage;
      shouldRun = true;

      async function connect(): Promise<void> {
        // Tear down any prior socket before replacing it, so its listeners are
        // released and it can't fire a competing 'close' → reconnect chain.
        if (socket) {
          try {
            socket.close();
          } catch {
            /* ignore */
          }
        }
        // openSocket() can throw on a transient failure; do this BEFORE claiming
        // a new generation so a failed attempt leaves socketGeneration unchanged
        // and reconnectWithRetry's loop guard stays true (keeps retrying).
        const ws = await openSocket();
        const generation = ++socketGeneration;
        socket = ws;
        ws.addEventListener("message", (event) => {
          void handleEnvelope(event as MessageEvent<string>);
        });
        ws.addEventListener("close", () => {
          // Ignore if this socket has already been superseded or we're stopping.
          if (!shouldRun || generation !== socketGeneration) return;
          void reconnectWithRetry(generation);
        });
        ws.addEventListener("error", (err) => {
          logger.warn("Slack socket error", { err });
        });
        logger.info("Slack gateway adapter connected");
      }

      // Reconnect with capped backoff, retrying through transient openSocket
      // failures so a single failed attempt can't leave the adapter dead.
      async function reconnectWithRetry(fromGeneration: number): Promise<void> {
        let delayMs = 5000;
        while (shouldRun && fromGeneration === socketGeneration) {
          await new Promise((r) => setTimeout(r, delayMs));
          if (!shouldRun || fromGeneration !== socketGeneration) return;
          try {
            await connect();
            return;
          } catch (err) {
            logger.error(`Slack reconnect failed; retrying in ${Math.round(delayMs / 1000)}s`, {
              err,
            });
            delayMs = Math.min(delayMs * 2, 60_000);
          }
        }
      }

      await connect();
    },

    async stop() {
      shouldRun = false;
      socket?.close();
    },

    async send(chatId, text, opts) {
      const blocks = buildBlocks(text, opts?.buttons);
      const body = await post("chat.postMessage", {
        channel: chatId,
        text,
        thread_ts: opts?.threadId,
        ...(blocks ? { blocks } : {}),
      });
      return `${String(body.channel ?? chatId)}:${String(body.ts ?? "")}`;
    },

    async updateMessage(_chatId, msgId, text, opts) {
      const [channel, ts] = msgId.split(":");
      if (!channel || !ts) return;
      const blocks = buildBlocks(text, opts?.buttons);
      await post("chat.update", {
        channel,
        ts,
        text,
        ...(blocks ? { blocks } : {}),
      });
    },

    async sendWithButtons(chatId, text, buttons, opts) {
      const blocks = buildBlocks(text, buttons);
      const body = await post("chat.postMessage", {
        channel: chatId,
        text,
        thread_ts: opts?.threadId,
        ...(blocks ? { blocks } : {}),
      });
      return `${String(body.channel ?? chatId)}:${String(body.ts ?? "")}`;
    },
  };
}

registerAdapter("slack", (startTime) => createSlackAdapter(startTime));
