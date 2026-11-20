import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleX,
  LoaderCircle,
  type LucideIcon,
} from "lucide-react";
import type { LiveSession } from "@/api/client";

export const AGENT_STATE_ORDER = [
  "needs-you",
  "failed",
  "done",
  "working",
  "idle",
  "ended",
  "unknown",
] as const;
export type AgentState = (typeof AGENT_STATE_ORDER)[number];

export const AGENT_STATES: Record<
  AgentState,
  { label: string; help: string; Icon: LucideIcon; tone: string; spin?: boolean }
> = {
  "needs-you": {
    label: "Needs you",
    help: "Waiting for your answer or approval",
    Icon: CircleAlert,
    tone: "text-warning",
  },
  failed: { label: "Failed", help: "Stopped with an error", Icon: CircleX, tone: "text-error" },
  done: {
    label: "Done",
    help: "Finished a turn you have not seen yet",
    Icon: CircleCheck,
    tone: "text-secondary",
  },
  working: {
    label: "Working",
    help: "The agent is working",
    Icon: LoaderCircle,
    tone: "text-progress",
    spin: true,
  },
  idle: {
    label: "Idle",
    help: "Ready for your next message",
    Icon: Circle,
    tone: "text-muted-foreground",
  },
  ended: {
    label: "Ended",
    help: "The session has ended",
    Icon: CircleDashed,
    tone: "text-muted-foreground",
  },
  unknown: {
    label: "Unknown",
    help: "No agent activity is available to determine its state",
    Icon: CircleHelp,
    tone: "text-muted-foreground",
  },
};

const rank = (state: AgentState) => AGENT_STATE_ORDER.indexOf(state);

export function moreUrgent(a: AgentState, b: AgentState): AgentState {
  return rank(a) <= rank(b) ? a : b;
}

/** A group's state is its most urgent child's; quiet groups (only idle or ended) show nothing. */
export function rollupState(states: Iterable<AgentState | null | undefined>): AgentState | null {
  let result: AgentState | null = null;
  for (const state of states) if (state) result = result ? moreUrgent(result, state) : state;
  return result === "idle" || result === "ended" || result === "unknown" ? null : result;
}

const LIVE_STATES: Record<LiveSession["status"], AgentState> = {
  running: "working",
  error: "failed",
  idle: "idle",
  stopped: "ended",
};

export function liveSessionState(
  session: Pick<
    LiveSession,
    "status" | "waiting_for_human" | "working_children" | "waiting_children"
  >,
): AgentState {
  // A child parked on a question or approval needs the human through its parent too.
  if (session.waiting_for_human || (session.waiting_children ?? 0) > 0) return "needs-you";
  const base = LIVE_STATES[session.status] ?? "unknown";
  // An idle parent whose children still hold turns is working, not idle.
  if (base === "idle" && (session.working_children ?? 0) > 0) return "working";
  return base;
}

export function chatSessionState(input: {
  needsYou: boolean;
  failed: boolean;
  streaming: boolean;
  reconnecting: boolean;
  refreshing: boolean;
  turnElsewhere: boolean;
  runClaim: boolean;
  hasThread: boolean;
  workingChildren?: number;
  waitingChildren?: number;
}): AgentState | null {
  if (input.needsYou || (input.waitingChildren ?? 0) > 0) return "needs-you";
  if (input.failed) return "failed";
  if (
    input.streaming ||
    input.reconnecting ||
    input.turnElsewhere ||
    (input.refreshing && input.runClaim) ||
    (input.workingChildren ?? 0) > 0
  )
    return "working";
  return input.hasThread ? "idle" : null;
}

type Waiting = NonNullable<LiveSession["waiting_for"]>;

const shortTool = (tool: string) => tool.split("__").pop() || tool;

export function waitingLabel(waiting: Waiting): string {
  return waiting.tool ? `${waiting.reason} · ${shortTool(waiting.tool)}` : waiting.reason;
}

export function pendingLabel(waiting: Waiting): string {
  return `${waiting.tool ? `${shortTool(waiting.tool)} ` : ""}${waiting.reason} pending · sends queue`;
}
