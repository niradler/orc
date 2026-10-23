import { appendChatActivity, type ChatMessage } from "@orc/core/chat";
import type { TranscriptTurn } from "./transcript.js";

/** Display the imported transcript without replaying it as a new prompt. */
export function chatHistory(turns: TranscriptTurn[], agent: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const turn of turns) {
    if (turn.role === "system") continue;
    const content = turn.blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const timestamp = turn.time ? Date.parse(turn.time) : Date.now();
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      role: turn.role === "user" ? "user" : "assistant",
      content,
      timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
      agent,
      activity: [],
    };
    for (const block of turn.blocks) {
      if (block.type === "thinking")
        message.activity = appendChatActivity(message.activity ?? [], {
          type: "thinking",
          text: block.text,
        });
      if (block.type === "tool_use") {
        const id = block.id ?? crypto.randomUUID();
        message.activity = appendChatActivity(message.activity ?? [], {
          type: "tool_use",
          data: { id, name: block.name, input: block.input },
        });
        if (block.result !== undefined)
          message.activity = appendChatActivity(message.activity, {
            type: "tool_result",
            data: { toolUseId: id, content: block.result, isError: false },
          });
      }
      if (block.type === "tool_result") {
        const owner =
          [...messages]
            .reverse()
            .find(
              (previous) =>
                previous.role === "assistant" &&
                previous.activity?.some((item) => item.type === "tool" && item.id === block.forId),
            ) ?? message;
        owner.activity = appendChatActivity(owner.activity ?? [], {
          type: "tool_result",
          data: {
            toolUseId: block.forId ?? crypto.randomUUID(),
            content: block.text,
            isError: false,
          },
        });
      }
    }
    if (message.content || message.activity?.length) messages.push(message);
  }
  return messages;
}
