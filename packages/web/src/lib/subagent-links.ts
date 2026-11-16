import { readChatActivity } from "@orc/core/chat";
import type { SessionSubagents } from "@orc/core/session-messages";

export type SessionSubagent = SessionSubagents["subagents"][number];

const SUBAGENT_TOOLS = new Set(["agent", "task", "spawn_agent", "subagent"]);

export function isSubagentTool(name: string): boolean {
  return SUBAGENT_TOOLS.has(name.toLowerCase());
}

export function matchSubagents(
  messages: readonly { activity?: unknown }[],
  subagents: readonly SessionSubagent[],
): Map<string, SessionSubagent> {
  const calls = messages.flatMap((message) =>
    readChatActivity(message.activity).activity.flatMap((item) =>
      item.type === "tool" && isSubagentTool(item.name) ? [item.id] : [],
    ),
  );
  const links = new Map<string, SessionSubagent>();
  const byCall = new Map(
    subagents.flatMap((subagent) =>
      subagent.tool_call_id ? [[subagent.tool_call_id, subagent] as const] : [],
    ),
  );
  for (const call of calls) {
    const subagent = byCall.get(call);
    if (subagent) links.set(call, subagent);
  }
  const unlinked = subagents
    .filter((subagent) => !subagent.tool_call_id)
    .sort((a, b) => a.created_at - b.created_at);
  for (const call of calls) {
    if (links.has(call)) continue;
    const next = unlinked.shift();
    if (!next) break;
    links.set(call, next);
  }
  return links;
}
