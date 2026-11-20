import type { ChatActivity, ChatBackgroundKind } from "@orc/core/chat";
import type { SessionStatus, SessionSubagents } from "@orc/core/session-messages";
import { toolView } from "./chat-tools";
import { liveSubagentTree, subagentState } from "./subagent-links";

/** One row of work that continues while the agent is not writing anything. */
export type ChatBackgroundItem = {
  id: string;
  kind: ChatBackgroundKind;
  label: string;
  /** Epoch ms the work started; null when the backend did not say. */
  startedAt: number | null;
  status: "running" | "waiting" | "queued";
  /** The child chat session to open, when this is a session this chat started. */
  sessionId?: string;
  /** A discovered native session rather than a chat thread; opened via resume. */
  native?: boolean;
};

const SESSION_WORK_STATUS = new Set(["running", "waiting", "queued"]);
const SUBAGENT_LABEL_KEYS = ["description", "prompt", "name", "subagent_type"];

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstText(input: unknown, keys: string[]): string | undefined {
  const value = record(input);
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

/** What a detached tool call is doing: its command line, or the subagent it handed work to. */
function toolLabel(tool: Extract<ChatActivity, { type: "tool" }>): string {
  const view = toolView(tool);
  if (view.kind === "run") return view.command.split("\n")[0]?.trim() || tool.name;
  let input: unknown;
  try {
    input = tool.input.trim() ? JSON.parse(tool.input) : null;
  } catch {
    input = null;
  }
  return firstText(input, SUBAGENT_LABEL_KEYS) ?? tool.name;
}

/**
 * Detached calls from one turn, in the order the agent started them. When the agent reports
 * its subagents itself, their live tree replaces the detached subagent calls.
 */
export function backgroundActivity(activity: ChatActivity[]): ChatBackgroundItem[] {
  const reported = activity.some((item) => item.type === "subagent");
  const subagents = liveSubagentTree(activity).flatMap((node): ChatBackgroundItem[] => {
    const state = subagentState(node);
    if (state !== "working" && state !== "needs-you") return [];
    return [
      {
        id: node.id,
        kind: "subagent",
        label: node.title,
        startedAt: node.startedAt ?? null,
        status: state === "needs-you" ? "waiting" : "running",
      },
    ];
  });
  const calls = activity.flatMap((item): ChatBackgroundItem[] => {
    if (item.type !== "tool" || !item.background) return [];
    if (reported && item.background === "subagent") return [];
    return [
      {
        id: item.id,
        kind: item.background,
        label: toolLabel(item),
        startedAt: item.startedAt ?? null,
        status: "running",
      },
    ];
  });
  return [...calls, ...subagents];
}

/** Sessions this chat started that still hold work, as background rows. */
export function backgroundSessions(sessions: SessionStatus[]): ChatBackgroundItem[] {
  return sessions.flatMap((session): ChatBackgroundItem[] => {
    if (!SESSION_WORK_STATUS.has(session.status)) return [];
    return [
      {
        id: session.session_id,
        kind: "subagent",
        label: session.title,
        startedAt: session.started_at,
        status: session.status as ChatBackgroundItem["status"],
        sessionId: session.session_id,
      },
    ];
  });
}

/** Native subagents the provider started, from the live subagent query. */
export function backgroundSubagents(
  subagents: SessionSubagents["subagents"],
): ChatBackgroundItem[] {
  return subagents.flatMap((subagent): ChatBackgroundItem[] => {
    if (subagent.status !== "running") return [];
    return [
      {
        id: subagent.id,
        kind: "subagent",
        label: subagent.title || "Subagent",
        startedAt: subagent.created_at ? subagent.created_at * 1000 : null,
        status: "running",
        sessionId: subagent.id,
        native: true,
      },
    ];
  });
}

export function chatBackgroundWork(
  activity: ChatActivity[],
  sessions: SessionStatus[],
  subagents: SessionSubagents["subagents"] = [],
  streaming = true,
): ChatBackgroundItem[] {
  // Once the turn ends, its transcript is a frozen snapshot: subagent rows must come
  // from the live queries instead, or a finished subagent keeps reading as running.
  // Detached commands have no live query here and keep the transcript source.
  const fromActivity = backgroundActivity(activity).filter(
    (item) => streaming || item.kind === "command",
  );
  const seen = new Set<string>();
  return [
    ...fromActivity,
    ...backgroundSessions(sessions),
    ...backgroundSubagents(subagents),
  ].filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

/** "Running 2 commands and a subagent" — short, because the row sits in a narrow panel. */
export function backgroundSummary(items: ChatBackgroundItem[]): string {
  const commands = items.filter((item) => item.kind === "command").length;
  const subagents = items.length - commands;
  const part = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  const groups = [
    commands ? part(commands, "command") : "",
    subagents ? part(subagents, "subagent") : "",
  ].filter(Boolean);
  if (groups.length === 1) return `Running ${groups[0]}`;
  return `Running ${groups.slice(0, -1).join(", ")} and ${groups[groups.length - 1]}`;
}
