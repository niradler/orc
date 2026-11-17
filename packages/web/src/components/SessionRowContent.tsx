import {
  Activity,
  Bot,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldEllipsis,
  ShieldHalf,
  ShieldMinus,
  ShieldQuestionMark,
} from "lucide-react";
import type { ReactNode } from "react";
import type { LiveSession } from "@/api/client";
import { ActionHelp } from "@/components/ActionHelp";
import { AgentIcon, agentDisplayName } from "@/components/AgentIcon";
import { StateBadge } from "@/components/StateBadge";
import { type AgentState, waitingLabel } from "@/lib/agent-state";
import { sessionModeLabel } from "@/lib/chat-history-list";
import { cn } from "@/lib/utils";

export const sessionRowClass = "group flex min-w-0 items-center rounded-md";
export const sessionRowButtonClass =
  "flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left disabled:opacity-60 max-sm:min-h-11 pointer-coarse:min-h-11";

export const MODE_ICONS = {
  default: ShieldQuestionMark,
  acceptEdits: ShieldCheck,
  "workspace-write": ShieldCheck,
  auto: ShieldHalf,
  plan: ShieldEllipsis,
  "read-only": ShieldMinus,
  bypassPermissions: ShieldAlert,
  "danger-full-access": ShieldAlert,
} as const;

export function SessionModeIcon({ mode }: { mode: string | null | undefined }): ReactNode {
  if (!mode) return null;
  const scope = mode.split("/").pop() ?? mode;
  const Icon = MODE_ICONS[scope as keyof typeof MODE_ICONS] ?? Shield;
  const label = sessionModeLabel(mode);
  return (
    <ActionHelp label={label}>
      <span
        role="img"
        aria-label={label}
        data-testid="chat-session-mode"
        data-mode={mode}
        className={cn("inline-flex shrink-0", Icon === ShieldAlert && "text-warning")}
      >
        <Icon size={12} aria-hidden="true" />
      </span>
    </ActionHelp>
  );
}

export function SubagentChip({ count }: { count: number | undefined }): ReactNode {
  if (!count) return null;
  const label = `${count} ${count === 1 ? "subagent" : "subagents"}`;
  return (
    <ActionHelp label={label}>
      <span
        role="img"
        aria-label={label}
        data-testid="chat-session-subagent-count"
        className="inline-flex shrink-0 items-center gap-0.5 text-[10px] text-outline"
      >
        <Bot size={11} aria-hidden="true" />
        {count}
      </span>
    </ActionHelp>
  );
}

export function SessionRunChip({
  session,
}: {
  session: Pick<LiveSession, "waiting_for" | "background_work"> | null;
}): ReactNode {
  if (session?.waiting_for) {
    const full = session.waiting_for.tool
      ? `${session.waiting_for.reason} · ${session.waiting_for.tool}`
      : session.waiting_for.reason;
    return (
      <ActionHelp label={full}>
        <span
          data-testid="chat-session-waiting"
          data-label={full}
          className="max-w-full shrink-0 truncate text-warning"
        >
          {waitingLabel(session.waiting_for)}
        </span>
      </ActionHelp>
    );
  }
  if (!session?.background_work) return null;
  return (
    <ActionHelp label="Background work running">
      <span
        role="img"
        aria-label="Background work running"
        data-testid="chat-session-background"
        className="inline-flex shrink-0 text-progress"
      >
        <Activity size={11} aria-hidden="true" />
      </span>
    </ActionHelp>
  );
}

export function SessionRowContent({
  agent,
  title,
  state,
  stateTestId,
  compact = true,
  marker,
  mode,
  model,
  badge,
}: {
  agent: string;
  title: ReactNode;
  state: AgentState;
  stateTestId: string;
  compact?: boolean;
  marker?: ReactNode;
  mode?: string | null;
  model?: string;
  badge?: ReactNode;
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
      {mode || model || badge ? (
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px]">{title}</span>
          <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
            <SessionModeIcon mode={mode} />
            {model && (
              <span data-testid="chat-session-run" className="min-w-0 truncate">
                {model}
              </span>
            )}
            {badge}
          </span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate text-[13px]">{title}</span>
      )}
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
