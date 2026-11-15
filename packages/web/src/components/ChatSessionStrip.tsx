import type { SessionCacheUsage } from "@orc/core/usage";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { AgentIcon, agentDisplayName } from "@/components/AgentIcon";
import { HelpPopover } from "@/components/HelpPopover";
import { StateBadge } from "@/components/StateBadge";
import type { AgentState } from "@/lib/agent-state";
import { formatTokenCount } from "@/lib/live-sessions";
import { cn } from "@/lib/utils";

const count = new Intl.NumberFormat();

/** The usage API only knows the session's recorded requests; it carries no model window. */
export function useChatContextUsage(sourceId: string | null | undefined, live: boolean) {
  return useQuery({
    // Same key as SessionCacheUsage: one read feeds both surfaces.
    queryKey: ["session-cache", sourceId ?? "", live],
    queryFn: () => api.sessions.cacheUsage(sourceId ?? ""),
    enabled: !!sourceId,
    staleTime: 15_000,
    refetchInterval: live ? 15_000 : false,
    retry: 1,
  });
}

/**
 * Context is the input an agent re-sends with each request. The only share the
 * usage API can express is how much of it came from the provider's cache; a
 * session with no recorded request has no figure at all, so it is omitted.
 */
export function contextFigure(
  latest: SessionCacheUsage["latest"] | null | undefined,
): { tokens: number; percent: number } | null {
  if (!latest || latest.input_tokens <= 0) return null;
  const percent = Math.round((latest.cached_input_tokens / latest.input_tokens) * 100);
  return { tokens: latest.input_tokens, percent: Math.min(100, Math.max(0, percent)) };
}

/** A quiet one-line summary of the session, not another control row. */
export function ChatSessionStrip({
  agent,
  model,
  state,
  latest,
  compactions = 0,
  compact = false,
  className,
}: {
  agent: string;
  model?: string | undefined;
  state: AgentState | null;
  latest?: SessionCacheUsage["latest"] | undefined;
  compactions?: number;
  /** Phone and narrow panels: the composer already names agent and model. */
  compact?: boolean;
  className?: string;
}) {
  const figure = contextFigure(latest);
  if (!agent && !figure && !state) return null;
  return (
    <div
      data-testid="chat-session-strip"
      className={cn(
        "flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs text-on-surface-variant",
        className,
      )}
    >
      {!compact && (
        <>
          <span
            data-testid="chat-session-strip-agent"
            className="inline-flex min-w-0 shrink items-center gap-1"
          >
            <AgentIcon agent={agent} decorative size={12} />
            <span className="truncate">{agentDisplayName(agent)}</span>
          </span>
          {model && (
            <>
              <Separator />
              <span
                data-testid="chat-session-strip-model"
                title={model}
                className="max-w-56 truncate font-mono text-[11px]"
              >
                {model}
              </span>
            </>
          )}
        </>
      )}
      {figure && (
        <>
          {!compact && <Separator />}
          <span className="inline-flex min-w-0 shrink items-center gap-0.5">
            <span
              data-testid="chat-session-strip-context"
              className="truncate tabular-nums"
              title={`${formatTokenCount(figure.tokens, false)} tokens in the latest request, ${figure.percent}% served from cache`}
            >
              {figure.percent}% cached
            </span>
            <HelpPopover label="context usage" testId="chat-context-help">
              <p>
                Context is the conversation the agent re-sends with every request. The latest
                request carried {formatTokenCount(figure.tokens, false)} tokens (
                {count.format(figure.tokens)}), and {figure.percent}% came from the provider's
                cache, so only the rest was new input.
              </p>
              <p className="mt-2">
                {compactions > 0
                  ? `${compactions} ${compactions === 1 ? "compaction has" : "compactions have"} summarized this session's context; each appears as a divider in the conversation.`
                  : "Context compaction summarizes the conversation to free context; a recorded compaction appears as a divider."}{" "}
                Figures appear only when the agent records usage for this session.
              </p>
            </HelpPopover>
          </span>
        </>
      )}
      {state && (
        <>
          {(!compact || figure) && <Separator />}
          <StateBadge
            state={state}
            compact={compact}
            testId="chat-session-strip-state"
            className="shrink-0"
          />
        </>
      )}
    </div>
  );
}

function Separator() {
  return (
    <span aria-hidden="true" className="shrink-0 text-outline">
      ·
    </span>
  );
}
