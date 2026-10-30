import type { HumanRequest } from "@orc/core/human-requests";
import { currentHumanRequest, type HumanRequestStore } from "@orc/db/human-requests";
import { redactSecrets } from "./redact.js";
import type { GatewayAdapter, IncomingMessage, SupportsInlineButtons } from "./types.js";

type Target = {
  platform: string;
  provider?: string;
  chat_id: string;
  project_id: string | null;
  thread_id: string | null;
};
const destination = (chatId: string, threadId?: string | null) =>
  JSON.stringify([chatId, threadId ?? null]);
const credentialFields = new Set([
  "token",
  "bottoken",
  "apptoken",
  "accesstoken",
  "refreshtoken",
  "secret",
  "clientsecret",
  "password",
  "apikey",
  "authorization",
  "cookie",
  "privatekey",
  "credentials",
  "orcapisecret",
  "orctelegramtoken",
]);
function privateInput(value: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (typeof value === "string")
    return (
      redactSecrets(value) !== value ||
      /Bearer\s+\S+|(?:password|secret|token|api[_-]?key)\s*[=:]\s*\S+/i.test(value)
    );
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => privateInput(item, depth + 1));
  return Object.entries(value).some(
    ([key, item]) =>
      (credentialFields.has(key.replace(/[_-]/g, "").toLowerCase()) &&
        item !== null &&
        item !== "") ||
      privateInput(item, depth + 1),
  );
}

/** Uses the existing gateway's authorized targets and event dispatch. No agent listener. */
export class HumanRequestChannels {
  constructor(private readonly store: HumanRequestStore) {}

  async notify(adapters: ReadonlyMap<string, GatewayAdapter>, targets: Target[]): Promise<void> {
    for (const entry of this.store.list()) {
      const request = currentHumanRequest(this.store, entry.id);
      if (request.status !== "pending") continue;
      for (const target of targets) {
        const source = request.input.origin.channel;
        if (
          source &&
          (target.platform !== `${source.connection}:${source.target}` ||
            target.chat_id !== source.chat_id ||
            (target.thread_id ?? null) !== (source.thread_id ?? null))
        )
          continue;
        if (
          !request.input.notify.includes(
            (target.provider ?? target.platform) as "telegram" | "slack",
          ) ||
          target.project_id !== request.input.project_id
        )
          continue;
        const adapter = adapters.get(target.platform);
        if (!adapter) continue;
        const action = request.input.action;
        const sensitive = privateInput(request.input);
        const detail = sensitive
          ? "This request contains sensitive input. Review it in ORC."
          : [
              request.input.prompt,
              action
                ? `Host: ${action.host}\nFolder: ${action.cwd}\n${action.tool}\n${JSON.stringify(action.input, null, 2)}`
                : "",
              request.input.choices.length
                ? `Choices:\n${request.input.choices.map((choice) => `${choice}${Object.hasOwn(request.input.choice_descriptions, choice) && request.input.choice_descriptions[choice] ? `: ${request.input.choice_descriptions[choice]}` : ""}`).join("\n")}`
                : "",
            ]
              .filter(Boolean)
              .join("\n\n");
        const canReply = !sensitive && detail.length <= 2400 && !request.input.multi_select;
        const key = destination(target.chat_id, target.thread_id);
        if (!this.store.reserveNotification(request, target.platform, key, canReply)) continue;
        const command = `/attention ${request.id} ${request.version}`;
        const instructions = !canReply
          ? "Open Attention needed in ORC to review and respond."
          : request.input.kind === "approval"
            ? `${command} approve\n${command} deny`
            : `${command} answer Your answer here`;
        const text = `Attention needed · ${sensitive ? "ORC" : request.input.origin.backend}\n${detail.slice(0, 2800)}${canReply ? "" : "\n[Full request in ORC]"}\n\n${instructions}`;
        try {
          const buttons = !canReply
            ? []
            : request.input.kind === "approval"
              ? [
                  [
                    { label: "Approve", value: `${command} approve` },
                    { label: "Deny", value: `${command} deny` },
                  ],
                ]
              : request.input.choices.map((choice) => [
                  { label: choice.slice(0, 60), value: `${command} answer ${choice}` },
                ]);
          if (buttons.length && "sendWithButtons" in adapter)
            await (adapter as GatewayAdapter & SupportsInlineButtons).sendWithButtons(
              target.chat_id,
              text,
              buttons,
              { threadId: target.thread_id ?? undefined, projectId: request.input.project_id },
            );
          else
            await adapter.send(target.chat_id, text, {
              threadId: target.thread_id ?? undefined,
              projectId: request.input.project_id,
            });
          this.store.notificationSent(request.id, target.platform, key);
        } catch {
          // The durable lease retries after reconnect; duplicate notifications cannot duplicate decisions.
        }
      }
    }
  }

  /** Must only be called after the gateway verifies the current authorized user. */
  reply(message: IncomingMessage): string | null {
    if (!/^\/attention(?:@\w+)?(?:\s|$)/.test(message.text.trim())) return null;
    const match = message.text
      .trim()
      .match(/^\/attention(?:@\w+)?\s+(\S+)\s+(\d+)\s+(approve|deny|answer)(?:\s+([\s\S]+))?$/);
    if (!match)
      return "Use /attention <request-id> <version> answer <text>, approve, or deny. Open Attention needed in ORC for request details.";
    const [, id = "", rawVersion, operation, answer] = match;
    const version = Number(rawVersion);
    try {
      if (
        !this.store.canReply(
          id,
          version,
          message.connectionId ?? message.platform,
          destination(message.chatId, message.threadId),
        )
      )
        return "This request was not offered for replies in this chat/thread. Open Attention needed in ORC.";
      const request: HumanRequest = currentHumanRequest(this.store, id);
      if (request.input.origin.channel && request.input.origin.channel.sender_id !== message.userId)
        return "Only the originating sender may answer this request.";
      if (request.input.kind === "question") {
        if (operation !== "answer" || !answer?.trim()) return "This question needs an answer.";
        this.store.respond(id, version, { kind: "question", answer });
      } else {
        if (operation === "answer") return "This action needs approve or deny.";
        this.store.respond(id, version, { kind: "approval", approved: operation === "approve" });
      }
      return "Response saved. ORC will deliver it to the originating agent; check Attention needed for delivery status.";
    } catch {
      return "This request is stale, cancelled, expired, or already answered. Reload Attention needed in ORC.";
    }
  }
}
