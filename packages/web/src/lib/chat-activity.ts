import type { ChatActivity } from "@orc/core/chat";

type Work = Extract<ChatActivity, { type: "tool" | "thinking" }>;
export type ActivityGroup = ChatActivity | { type: "tools"; id: string; items: Work[] };

export function groupChatActivity(items: ChatActivity[]): ActivityGroup[] {
  const grouped: ActivityGroup[] = [];
  for (const item of items) {
    const previous = grouped[grouped.length - 1];
    if (item.type === "status" || !previous || previous.type === "status") grouped.push(item);
    else if (previous.type === "tools") previous.items.push(item);
    else grouped[grouped.length - 1] = { type: "tools", id: previous.id, items: [previous, item] };
  }
  return grouped;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function activitySummary(items: Work[]): string {
  const tools = items.filter((item) => item.type === "tool").length;
  const thoughts = items.length - tools;
  return [tools && plural(tools, "tool call"), thoughts && plural(thoughts, "thought")]
    .filter(Boolean)
    .join(" · ");
}
