import type { HumanRequest } from "@orc/core/human-requests";
import { currentHumanRequest, type HumanRequestStore } from "@orc/db/human-requests";
import type { GatewayAdapter, IncomingMessage } from "./types.js";

type Target = {
  platform: string;
  chat_id: string;
  project_id: string | null;
  thread_id: string | null;
};
const destination = (chatId: string, threadId?: string | null) =>
  JSON.stringify([chatId, threadId ?? null]);

/** Uses the existing gateway's authorized targets and event dispatch. No agent listener. */
export class HumanRequestChannels {
  constructor(private readonly store: HumanRequestStore) {}

  async notify(adapters: ReadonlyMap<string, GatewayAdapter>, targets: Target[]): Promise<void> {
    for (const entry of this.store.list()) {
      const request = currentHumanRequest(this.store, entry.id);
      if (request.status !== "pending") continue;
      for (const target of targets) {
        if (
          !request.input.notify.includes(target.platform as "telegram" | "slack") ||
          target.project_id !== request.input.project_id
        )
          continue;
        const adapter = adapters.get(target.platform);
        if (!adapter) continue;
        const action = request.input.action;
        const detail = [
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
        const canReply = detail.length <= 2800 && !request.input.multi_select;
        const key = destination(target.chat_id, target.thread_id);
        if (!this.store.reserveNotification(request, target.platform, key, canReply)) continue;
        const command = `/attention ${request.id} ${request.version}`;
        const instructions = !canReply
          ? "Open Attention needed in ORC to review and respond."
          : request.input.kind === "approval"
            ? `${command} approve\n${command} deny`
            : `${command} answer Your answer here`;
        const text = `Attention needed · ${request.input.origin.backend}\n${detail.slice(0, 2800)}${canReply ? "" : "\n[Full request in ORC]"}\n\n${instructions}`;
        try {
          await adapter.send(target.chat_id, text, { threadId: target.thread_id ?? undefined });
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
          message.platform,
          destination(message.chatId, message.threadId),
        )
      )
        return "This request was not offered for replies in this chat/thread. Open Attention needed in ORC.";
      const request: HumanRequest = currentHumanRequest(this.store, id);
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
