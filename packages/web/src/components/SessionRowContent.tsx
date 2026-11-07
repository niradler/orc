import type { ReactNode } from "react";
import { AgentIcon, agentDisplayName } from "@/components/AgentIcon";
import { StateBadge } from "@/components/StateBadge";
import type { AgentState } from "@/lib/agent-state";

export const sessionRowClass = "group flex min-w-0 items-center rounded-md";
export const sessionRowButtonClass =
  "flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left disabled:opacity-60 max-sm:min-h-11 pointer-coarse:min-h-11";

export function SessionRowContent({
  agent,
  title,
  state,
  stateTestId,
  compact = true,
  marker,
}: {
  agent: string;
  title: ReactNode;
  state: AgentState;
  stateTestId: string;
  compact?: boolean;
  marker?: ReactNode;
}): ReactNode {
  return (
    <>
      <AgentIcon
        agent={agent}
        title={agentDisplayName(agent)}
        data-testid="chat-session-provider"
        data-provider={agent || "unknown"}
        className="size-5 shrink-0 text-muted-foreground"
      />
      <span className="min-w-0 flex-1 truncate text-[13px]">{title}</span>
      {marker}
      <StateBadge
        state={state}
        compact={compact}
        context={compact ? agent || undefined : undefined}
        testId={stateTestId}
      />
    </>
  );
}
