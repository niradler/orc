import { ChatTurnSchema } from "@orc/core/chat";
import { ArrowRightLeft, ChevronsDownUp } from "lucide-react";
import { memo } from "react";
import { foldTurn, formatDuration } from "@/lib/chat-activity";
import { type ChatDivider, compactionDividerLabel } from "@/lib/chat-dividers";
import { formatTokenCount } from "@/lib/live-sessions";
import { cn } from "@/lib/utils";

const count = new Intl.NumberFormat();

export function ChatTurnDivider({ divider }: { divider: ChatDivider }) {
  return (
    <div
      data-testid={`chat-turn-divider-${divider.type === "model" ? "model" : "compaction"}`}
      className="mx-auto mb-3 flex w-full max-w-(--chat-width) items-center gap-2 text-xs text-on-surface-variant"
    >
      <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-outline-variant" />
      <span className="flex min-w-0 items-center gap-1.5">
        {divider.type === "model" ? (
          <>
            <ArrowRightLeft aria-hidden="true" size={12} className="shrink-0" />
            <span data-testid="chat-turn-divider-label" className="truncate">
              Model changed to <span className="font-mono text-[11px]">{divider.model}</span>
            </span>
          </>
        ) : (
          <>
            <ChevronsDownUp aria-hidden="true" size={12} className="shrink-0" />
            <CompactionDividerLabel divider={divider} />
          </>
        )}
      </span>
      <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-outline-variant" />
    </div>
  );
}

function CompactionDividerLabel({
  divider,
}: {
  divider: Extract<ChatDivider, { type: "compact" }>;
}) {
  const { label, drop } = compactionDividerLabel(divider);
  return (
    <span data-testid="chat-turn-divider-label" className="truncate">
      {label}
      {drop && <span className="tabular-nums"> · {drop}</span>}
    </span>
  );
}

/**
 * Per-turn metadata beside the actions. Every field is optional in the
 * contract, so a missing value is omitted rather than shown as zero.
 */
export const ChatTurnMeta = memo(function ChatTurnMeta({
  turn,
  model,
  tokens,
  cachedTokens,
}: {
  turn: unknown;
  model?: string | undefined;
  tokens?: number | undefined;
  cachedTokens?: number | undefined;
}) {
  const timing = ChatTurnSchema.safeParse(turn);
  const { outcome, finishedAt } = timing.success ? timing.data : {};
  const durationMs = timing.success ? foldTurn([], timing.data).durationMs : null;
  const reason = outcome === "stopped" ? "Stopped" : outcome === "failed" ? "Failed" : null;
  const verb =
    reason === "Stopped" ? "Stopped after" : reason === "Failed" ? "Failed after" : "Worked for";
  const ended = finishedAt
    ? new Date(finishedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;
  const percent =
    tokens && tokens > 0 && cachedTokens !== undefined
      ? Math.min(100, Math.max(0, Math.round((cachedTokens / tokens) * 100)))
      : null;
  if (durationMs === null && !model && !tokens && !reason) return null;
  return (
    <div
      data-testid="chat-turn-meta"
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
    >
      {model && (
        <span
          data-testid="chat-turn-model"
          title="Model that produced this turn"
          className="min-w-0 max-w-56 truncate font-mono text-[11px]"
        >
          {model}
        </span>
      )}
      {tokens ? (
        <span
          data-testid="chat-turn-tokens"
          title={`${count.format(tokens)} input tokens in the latest request of this turn`}
          className="tabular-nums"
        >
          {formatTokenCount(tokens, false)} tokens
        </span>
      ) : null}
      {percent !== null && (
        <span
          data-testid="chat-turn-cache"
          title={`${percent}% of the latest request's input came from the provider's cache`}
          className="tabular-nums"
        >
          {percent}% cached
        </span>
      )}
      {durationMs !== null && (
        <time
          data-testid="chat-message-duration"
          dateTime={finishedAt ? new Date(finishedAt).toISOString() : undefined}
          title={[`${verb} ${formatDuration(durationMs)}`, ended && `ended ${ended}`]
            .filter(Boolean)
            .join(", ")}
          className="tabular-nums"
        >
          {!reason && <span className="sr-only">{verb} </span>}
          {formatDuration(durationMs)}
        </time>
      )}
      {reason && (
        <span data-testid="chat-turn-stop" className={cn(reason === "Failed" && "text-error")}>
          {reason}
        </span>
      )}
    </div>
  );
});
