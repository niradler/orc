import { contextFigure, useChatContextUsage } from "@/components/ChatSessionStrip";
import { HelpPopover } from "@/components/HelpPopover";
import { useChat } from "@/hooks/useChat";
import { formatTokenCount } from "@/lib/live-sessions";
import { contextUsageHelp } from "@/lib/session-cache";
import { Failure, Loading, Panel } from "./primitives";

/**
 * The same figure as the chat header strip, for a session the answer talks about.
 * Only the thread you have open keeps polling; a historical session is read once.
 * A session with no recorded request has no figure, so nothing reads as zero.
 */
export function SessionUsageCard({ sessionId }: { sessionId: string }) {
  const live = useChat().thread?.sourceId === sessionId;
  const { data, isLoading, error } = useChatContextUsage(sessionId, live);
  if (isLoading) return <Loading label="Loading session usage" />;
  if (error) return <Failure label="Session usage unavailable." error={error} />;
  const figure = contextFigure(data?.latest);
  const compactions = data?.compactions?.length ?? 0;
  const help = figure ? contextUsageHelp(figure.tokens, figure.percent, compactions) : null;
  return (
    <Panel testId="chat-ui-session-usage" className="space-y-1">
      <div className="flex min-w-0 items-center gap-1">
        <p className="min-w-0 flex-1 text-xs text-on-surface-variant">Session usage</p>
        {help && (
          <HelpPopover label="session usage" testId="chat-ui-session-usage-help">
            <p>{help.explanation}</p>
            <p className="mt-2">{help.note}</p>
          </HelpPopover>
        )}
      </div>
      {figure ? (
        <p
          data-testid="chat-ui-session-usage-figure"
          className="text-sm tabular-nums text-on-surface"
          title={`${formatTokenCount(figure.tokens, false)} tokens in the latest request, ${figure.percent}% served from cache`}
        >
          {formatTokenCount(figure.tokens, false)} input tokens
          <span className="text-on-surface-variant"> · {figure.percent}% cached</span>
        </p>
      ) : (
        <p data-testid="chat-ui-session-usage-empty" className="text-xs text-on-surface-variant">
          This session has no recorded usage yet.
        </p>
      )}
    </Panel>
  );
}
