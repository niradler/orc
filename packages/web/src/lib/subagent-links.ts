import { type ChatActivity, type ChatSubagentStatus, readChatActivity } from "@orc/core/chat";
import type { SessionSubagents } from "@orc/core/session-messages";
import { type AgentState, moreUrgent } from "./agent-state";

export type SessionSubagent = SessionSubagents["subagents"][number];

export type SubagentNode = {
  id: string;
  title: string;
  status: ChatSubagentStatus;
  tokens?: number;
  durationMs?: number;
  startedAt?: number;
  /** The discovered live session to open, when the agent recorded one. */
  sessionId?: string;
  children: SubagentNode[];
};

const SUBAGENT_TOOLS = new Set(["agent", "task", "spawn_agent", "subagent"]);

const SESSION_STATUS: Record<string, ChatSubagentStatus> = {
  running: "running",
  error: "failed",
};

const NODE_STATE: Record<ChatSubagentStatus, AgentState> = {
  running: "working",
  waiting: "needs-you",
  failed: "failed",
  completed: "done",
  stopped: "ended",
};

export function isSubagentTool(name: string): boolean {
  return SUBAGENT_TOOLS.has(name.toLowerCase());
}

/** Nests flat subagents by parent; a parent missing from the list leaves its child at the top. */
export function subagentTree<T extends { id: string; parentId?: string | null | undefined }>(
  items: readonly T[],
  node: (item: T) => Omit<SubagentNode, "children">,
): SubagentNode[] {
  const nodes = new Map<string, SubagentNode>(
    items.map((item) => [item.id, { ...node(item), children: [] }]),
  );
  const roots: SubagentNode[] = [];
  for (const item of items) {
    const current = nodes.get(item.id) as SubagentNode;
    const parent = item.parentId && item.parentId !== item.id ? nodes.get(item.parentId) : null;
    if (parent && !contains(current, parent)) parent.children.push(current);
    else roots.push(current);
  }
  return roots;
}

function contains(node: SubagentNode, target: SubagentNode): boolean {
  return node === target || node.children.some((child) => contains(child, target));
}

/** A failed or waiting descendant marks the whole branch as needing you. */
export function subagentState(node: SubagentNode): AgentState {
  const own = NODE_STATE[node.status];
  const flagged = node.children.some((child) => {
    const state = subagentState(child);
    return state === "needs-you" || state === "failed";
  });
  return flagged ? moreUrgent(own, "needs-you") : own;
}

export function liveSubagentTree(activity: readonly ChatActivity[]): SubagentNode[] {
  return subagentTree(
    activity.flatMap((item) => (item.type === "subagent" ? [item] : [])),
    (item) => ({
      id: item.id,
      title: item.title || "Subagent",
      status: item.status,
      ...(item.tokens === undefined ? {} : { tokens: item.tokens }),
      ...(item.durationMs === undefined ? {} : { durationMs: item.durationMs }),
      ...(item.startedAt === undefined ? {} : { startedAt: item.startedAt }),
    }),
  );
}

export function matchSubagents(
  messages: readonly { activity?: unknown }[],
  subagents: readonly SessionSubagent[],
): Map<string, SubagentNode> {
  const calls = messages.flatMap((message) =>
    readChatActivity(message.activity).activity.flatMap((item) =>
      item.type === "tool" && isSubagentTool(item.name) ? [item.id] : [],
    ),
  );
  const roots = subagentTree(
    subagents.map((subagent) => ({ ...subagent, parentId: subagent.parent_id })),
    (subagent) => ({
      id: subagent.id,
      title: subagent.title,
      status: SESSION_STATUS[subagent.status] ?? "completed",
      sessionId: subagent.id,
    }),
  );
  const byId = new Map(roots.map((root) => [root.id, root]));
  const top = subagents.filter((subagent) => byId.has(subagent.id));
  const links = new Map<string, SubagentNode>();
  const byCall = new Map(
    top.flatMap((subagent) =>
      subagent.tool_call_id ? [[subagent.tool_call_id, subagent.id] as const] : [],
    ),
  );
  for (const call of calls) {
    const id = byCall.get(call);
    const root = id ? byId.get(id) : undefined;
    if (root) links.set(call, root);
  }
  const unlinked = top
    .filter((subagent) => !subagent.tool_call_id)
    .sort((a, b) => a.created_at - b.created_at);
  for (const call of calls) {
    if (links.has(call)) continue;
    const next = unlinked.shift();
    if (!next) break;
    links.set(call, byId.get(next.id) as SubagentNode);
  }
  return links;
}
