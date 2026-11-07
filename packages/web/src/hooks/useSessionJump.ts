import { useCallback, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useActiveLiveSessions } from "@/hooks/useActiveLiveSessions";
import { useChat } from "@/hooks/useChat";
import { useSessionSeen } from "@/hooks/useSessionSeen";
import { type AgentState, liveSessionState } from "@/lib/agent-state";
import { type JumpKind, type JumpTarget, nextJump } from "@/lib/command-palette";
import { needsUser } from "@/lib/session-filter";
import { lastSeen, unseenState } from "@/lib/session-seen";
import { workspaceDestination } from "@/lib/workspace-navigation";

/** Opens the next session that needs the user, then the next unseen Done. */
export function useSessionJump({
  projectId,
  onOpenChat,
}: {
  projectId: string;
  onOpenChat: () => void;
}) {
  const chat = useChat();
  const navigate = useNavigate();
  const { search } = useLocation();
  const { data: live } = useActiveLiveSessions();
  const seen = useSessionSeen();
  const visited = useRef(new Set<string>());
  const runtimes = new Set(chat.tabs.flatMap((tab) => tab.thread?.runtimeId ?? []));
  const targets: (JumpTarget & { open: () => void })[] = [];
  for (const tab of chat.tabs) {
    if (tab.key === chat.activeKey) continue;
    const state: AgentState | null =
      tab.permissions.length || tab.questions.length
        ? "needs-you"
        : tab.error
          ? "failed"
          : tab.attention && !tab.streaming
            ? "done"
            : null;
    if (!state) continue;
    targets.push({
      id: `tab:${tab.key}`,
      state,
      at: tab.messages[tab.messages.length - 1]?.timestamp ?? tab.createdAt ?? 0,
      open: () => {
        chat.selectTab(tab.key);
        onOpenChat();
      },
    });
  }
  for (const session of live ?? []) {
    if (session.session_id && runtimes.has(session.session_id)) continue;
    const at = Date.parse(session.last_activity_at ?? session.created_at) || 0;
    targets.push({
      id: `native:${session.id}`,
      state: unseenState(liveSessionState(session), at, lastSeen(seen, [`native:${session.id}`])),
      at,
      open: () =>
        navigate(
          workspaceDestination(
            `/sessions?session=${encodeURIComponent(session.id)}`,
            projectId,
            search,
          ),
        ),
    });
  }
  const jump = (kind: JumpKind = "any") => {
    const target = nextJump(targets, visited.current, kind);
    if (!target) return false;
    if (visited.current.has(target.id)) visited.current.clear();
    visited.current.add(target.id);
    target.open();
    return true;
  };
  const latest = useRef(jump);
  latest.current = jump;
  return {
    jump: useCallback((kind?: JumpKind) => latest.current(kind), []),
    needsYou: targets.filter((target) => needsUser(target.state)).length,
    done: targets.filter((target) => target.state === "done").length,
  };
}
