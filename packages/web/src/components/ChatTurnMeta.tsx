import { ChatTurnSchema } from "@orc/core/chat";
import { ArrowRightLeft, ChevronsDownUp } from "lucide-react";
import { memo } from "react";
import { foldTurn, formatDuration } from "@/lib/chat-activity";
import { formatTokenCount } from "@/lib/live-sessions";
import { cn } from "@/lib/utils";

const count = new Intl.NumberFormat();

export type ChatDivider =
  | { type: "model"; model: string }
  | { type: "compact"; pre: number | null; post: number | null };

type DividerMessage = {
  id: string;
  role: "user" | "assistant";
  timestamp: number;
  model?: string | undefined;
};

type DividerCompaction = {
  recorded_at: string | null;
  pre_tokens: number | null;
  post_tokens: number | null;
};

/**
 * Dividers mark real boundaries only: a recorded model change between
 * consecutive assistant turns, and a recorded compaction placed on the first
 * message that follows it. Anything without a recorded time or model is left
 * out rather than guessed.
 */
export function chatDividers(
  messages: readonly DividerMessage[],
  compactions: readonly DividerCompaction[] = [],
): { byMessage: Map<string, ChatDivider[]>; trailing: ChatDivider[] } {
  const byMessage = new Map<string, ChatDivider[]>();
  const trailing: ChatDivider[] = [];
  const push = (id: string | null, divider: ChatDivider) => {
    if (!id) trailing.push(divider);
    else byMessage.set(id, [...(byMessage.get(id) ?? []), divider]);
  };

  let previousModel: string | undefined;
  let turnStart: string | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      turnStart ??= message.id;
      continue;
    }
    if (message.model) {
      if (previousModel && previousModel !== message.model)
        push(turnStart ?? message.id, { type: "model", model: message.model });
      previousModel = message.model;
    }
    turnStart = null;
  }

  for (const compaction of compactions) {
    const at = compaction.recorded_at ? Date.parse(compaction.recorded_at) : Number.NaN;
    if (!Number.isFinite(at)) continue;
    push(messages.find((message) => message.timestamp >= at)?.id ?? null, {
      type: "compact",
      pre: compaction.pre_tokens,
      post: compaction.post_tokens,
    });
  }
  return { byMessage, trailing };
}

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
            <span data-testid="chat-turn-divider-label" className="truncate">
              Context compacted
              {divider.pre !== null && divider.post !== null && (
                <span className="tabular-nums">
                  {" "}
                  · {formatTokenCount(divider.pre, false)} → {formatTokenCount(divider.post, false)}{" "}
                  tokens
                </span>
              )}
            </span>
          </>
        )}
      </span>
      <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-outline-variant" />
    </div>
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
  if (!timing.success) return null;
  const { outcome, finishedAt } = timing.data;
  const durationMs = foldTurn([], timing.data).durationMs;
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
