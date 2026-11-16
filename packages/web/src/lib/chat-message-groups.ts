import type { ChatMessage } from "@orc/core/chat";

export interface ChatMessageGroups {
  messages: ChatMessage[];
  displayId: Map<string, string>;
}

const cache = new WeakMap<ChatMessage[], ChatMessageGroups>();

function merge(run: ChatMessage[]): ChatMessage {
  const first = run[0] as ChatMessage;
  const last = run[run.length - 1] as ChatMessage;
  if (run.length === 1) return first;
  const joined = <T>(pick: (message: ChatMessage) => T[] | undefined) => {
    const items = run.flatMap((message) => pick(message) ?? []);
    return items.length ? items : undefined;
  };
  return {
    ...first,
    id: last.id,
    content: run
      .map((message) => message.content)
      .filter(Boolean)
      .join("\n\n"),
    turn: last.turn ?? first.turn,
    model: last.model ?? first.model,
    activity: joined((message) => message.activity),
    providerActivity: joined((message) => message.providerActivity),
    attachments: joined((message) => message.attachments),
  };
}

export function groupChatMessages(messages: ChatMessage[]): ChatMessageGroups {
  const cached = cache.get(messages);
  if (cached) return cached;
  const grouped: ChatMessage[] = [];
  const displayId = new Map<string, string>();
  let run: ChatMessage[] = [];
  const flush = () => {
    if (!run.length) return;
    const merged = merge(run);
    for (const message of run) displayId.set(message.id, merged.id);
    grouped.push(merged);
    run = [];
  };
  for (const message of messages) {
    if (message.role === "assistant") {
      run.push(message);
      continue;
    }
    flush();
    displayId.set(message.id, message.id);
    grouped.push(message);
  }
  flush();
  const result = { messages: grouped, displayId };
  cache.set(messages, result);
  return result;
}
