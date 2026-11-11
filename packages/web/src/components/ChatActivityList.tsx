import { ChatActivitySchema, ChatTurnSchema } from "@orc/core/chat";
import { ChevronRight, CircleAlert } from "lucide-react";
import { useMemo } from "react";
import { ActivityRow } from "@/components/chat-ui/tool-renderers";
import { foldLabel, foldTurn } from "@/lib/chat-activity";

export function ChatActivityList({
  value,
  turn,
  live = false,
}: {
  value: unknown;
  turn?: unknown;
  live?: boolean;
}) {
  const items = useMemo(
    () =>
      Array.isArray(value)
        ? value.flatMap((item) => {
            const parsed = ChatActivitySchema.safeParse(item);
            return parsed.success ? [parsed.data] : [];
          })
        : [],
    [value],
  );
  const timing = ChatTurnSchema.safeParse(turn);
  const start = timing.success ? timing.data.startedAt : undefined;
  const end = timing.success ? timing.data.finishedAt : undefined;
  const durationMs = timing.success ? timing.data.durationMs : undefined;
  const outcome = timing.success ? timing.data.outcome : undefined;
  const fold = useMemo(
    () =>
      foldTurn(items, {
        ...(start !== undefined ? { startedAt: start } : {}),
        ...(end !== undefined ? { finishedAt: end } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      }),
    [items, start, end, durationMs],
  );
  if (!items.length && outcome !== "stopped" && outcome !== "failed") return null;
  const label = foldLabel(fold, live, outcome);
  return (
    <details
      data-testid="chat-turn-fold"
      data-live={live || undefined}
      data-failed={fold.failed > 0 || undefined}
      className="group/fold mb-1 text-xs text-on-surface-variant"
    >
      <summary
        data-testid="chat-turn-fold-summary"
        className="flex min-h-7 w-fit max-w-full cursor-pointer list-none items-center gap-2 rounded-md px-1.5 hover:bg-surface hover:text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-sm:min-h-10 [&::-webkit-details-marker]:hidden"
      >
        <span data-testid="chat-turn-fold-label" className="min-w-0 truncate">
          {label}
        </span>
        {fold.failed > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-error">
            <CircleAlert aria-hidden="true" size={12} />
            {fold.failed} failed
          </span>
        )}
        <ChevronRight
          aria-hidden="true"
          size={14}
          className="shrink-0 group-open/fold:rotate-90 motion-safe:transition-transform"
        />
      </summary>
      <section
        aria-label="Tool calls"
        data-testid="chat-activity"
        className="mt-1 ml-2 max-h-[min(28rem,60dvh)] overflow-y-auto border-l border-outline-variant pl-1"
      >
        {items.map((item) => (
          <ActivityRow key={item.id} item={item} live={live} />
        ))}
      </section>
    </details>
  );
}
