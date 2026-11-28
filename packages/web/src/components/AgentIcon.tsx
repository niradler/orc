import { agentLabel } from "@orc/core/coding-agents";
import { Bot } from "lucide-react";
import type { HTMLAttributes } from "react";
import { AGENT_MARKS } from "@/components/agent-marks";
import { resolveAgentId } from "@/lib/composer-chips";
import { cn } from "@/lib/utils";

export function agentDisplayName(agent: string | null | undefined): string {
  if (!agent) return "Unknown agent";
  const id = resolveAgentId(agent);
  return id ? agentLabel(id) : agent;
}

export function AgentIcon({
  agent,
  size = 16,
  decorative = false,
  className,
  ...props
}: {
  agent: string | null | undefined;
  size?: number;
  decorative?: boolean;
} & Omit<HTMLAttributes<HTMLSpanElement>, "children">) {
  const id = resolveAgentId(agent);
  const Mark = id ? AGENT_MARKS[id] : undefined;
  const name = agentDisplayName(agent);
  return (
    <span
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": name })}
      data-agent-mark={id ?? "fallback"}
      className={cn("inline-flex shrink-0 items-center justify-center text-current", className)}
      {...props}
    >
      {Mark ? <Mark size={size} /> : <Bot size={size} strokeWidth={1.75} aria-hidden="true" />}
    </span>
  );
}
