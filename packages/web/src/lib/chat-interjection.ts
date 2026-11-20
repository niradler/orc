import {
  type ChatActivity,
  type ChatEvent,
  type ChatMessage,
  ownsChatActivity,
} from "@orc/core/chat";

/** The live-turn fields a human interjection rearranges. */
export interface InterjectionState {
  messages: ChatMessage[];
  streamText: string;
  activity: ChatActivity[];
  assistantId: string;
  respondingAgent: string;
  thread?: { config: { model?: ChatMessage["model"] } } | null;
}

export interface InterjectionChange {
  messages: ChatMessage[];
  streamText?: string;
  activity?: ChatActivity[];
  assistantId?: string;
  /** The segment this split froze, when one was created; the run owns its activity. */
  sealedId?: string;
}

/**
 * A human message joined the live turn (a steer or a question answer). The prose
 * streamed so far freezes into its own assistant message before it and the stream
 * continues in a fresh segment, so the chat keeps the order things happened in.
 * The server records the same split; its event or the HTTP response may arrive
 * first, so the message is upserted and the split happens only once.
 */
export function withInterjection(tab: InterjectionState, message: ChatMessage): InterjectionChange {
  if (tab.messages.some((entry) => entry.id === message.id))
    return {
      messages: tab.messages.map((entry) => (entry.id === message.id ? message : entry)),
    };
  const segment: ChatMessage[] =
    tab.streamText || tab.activity.length
      ? [
          {
            id: tab.assistantId,
            role: "assistant",
            content: tab.streamText,
            activity: tab.activity,
            timestamp: Date.now(),
            agent: tab.respondingAgent,
            ...(tab.thread?.config.model ? { model: tab.thread.config.model } : {}),
          },
        ]
      : [];
  return {
    messages: [...tab.messages, ...segment, message],
    streamText: "",
    activity: [],
    assistantId: crypto.randomUUID(),
    ...(segment.length ? { sealedId: tab.assistantId } : {}),
  };
}

/**
 * The sealed segment of the current run that owns a stateful activity update.
 * Scoped to this run's seals: plan ids are constant across turns, so scanning
 * older history would rewrite a previous turn's plan in place.
 */
export function activityUpdateTarget(
  messages: ChatMessage[],
  sealedIds: string[],
  event: ChatEvent,
): ChatMessage | undefined {
  return [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" &&
        sealedIds.includes(message.id) &&
        ownsChatActivity(message.activity, event),
    );
}
