import { AGENT_STATES, type AgentState } from "@/lib/agent-state";
import { cn } from "@/lib/utils";

export function StateBadge({
  state,
  compact = false,
  context,
  testId = "state-badge",
  className,
}: {
  state: AgentState;
  compact?: boolean;
  context?: string;
  testId?: string;
  className?: string;
}) {
  const { label, help, Icon, tone } = AGENT_STATES[state];
  const name = context ? `${context} · ${label}` : label;
  const icon = (
    <Icon aria-hidden="true" size={14} strokeWidth={2.25} className={cn("shrink-0", tone)} />
  );
  if (compact)
    return (
      <span
        data-testid={testId}
        data-state={state}
        role="img"
        aria-label={name}
        title={`${name}: ${help}`}
        className={cn("inline-flex size-5 shrink-0 items-center justify-center", className)}
      >
        {icon}
      </span>
    );
  return (
    <span
      data-testid={testId}
      data-state={state}
      title={help}
      className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-xs", className)}
    >
      {icon}
      <span className="text-on-surface">{label}</span>
    </span>
  );
}
