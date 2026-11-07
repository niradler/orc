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
  { label: string; help: string; Icon: LucideIcon; tone: string }
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
  session: Pick<LiveSession, "status" | "waiting_for_human">,
): AgentState {
  return session.waiting_for_human ? "needs-you" : LIVE_STATES[session.status];
}
