import type { ChatActivity } from "@orc/core/chat";

type Tool = Extract<ChatActivity, { type: "tool" }>;
export type ActivityGroup = ChatActivity | { type: "tools"; id: string; items: Tool[] };
export function groupChatActivity(items: ChatActivity[]): ActivityGroup[] {
  const grouped: ActivityGroup[] = [];
  for (const item of items) {
    const previous = grouped[grouped.length - 1];
    if (item.type === "tool" && previous?.type === "tool")
      grouped[grouped.length - 1] = { type: "tools", id: previous.id, items: [previous, item] };
    else if (item.type === "tool" && previous?.type === "tools") previous.items.push(item);
    else grouped.push(item);
  }
  return grouped;
}
