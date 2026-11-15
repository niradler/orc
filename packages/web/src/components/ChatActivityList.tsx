import { ChatActivitySchema, ChatTurnSchema } from "@orc/core/chat";
import { ChevronRight, CircleAlert, EyeOff } from "lucide-react";
import { useMemo, useState } from "react";
import { ActivityRow } from "@/components/chat-ui/tool-renderers";
import { HelpPopover } from "@/components/HelpPopover";
import {
  ACTIVITY_FILTER_LABELS,
  ACTIVITY_FILTERS,
  ACTIVITY_PREFS_KEY,
  type ActivityPrefs,
  activityCounts,
  activityPrefsJson,
  DEFAULT_ACTIVITY_PREFS,
  filterActivity,
  foldSummary,
  foldTurn,
  parseActivityPrefs,
} from "@/lib/chat-activity";
import { cn } from "@/lib/utils";

function readPrefs(): ActivityPrefs {
  try {
    return parseActivityPrefs(localStorage.getItem(ACTIVITY_PREFS_KEY));
  } catch {
    return { ...DEFAULT_ACTIVITY_PREFS };
  }
}

function storePrefs(prefs: ActivityPrefs) {
  try {
    localStorage.setItem(ACTIVITY_PREFS_KEY, activityPrefsJson(prefs));
  } catch {}
}

function filterButtonClass(active: boolean, extra?: string) {
  return cn(
    "inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-lg:min-h-11",
    active ? "bg-surface-highest text-on-surface" : "text-muted-foreground hover:bg-surface",
    extra,
  );
}

function ActivityFilters({
  prefs,
  counts,
  onChange,
}: {
  prefs: ActivityPrefs;
  counts: ReturnType<typeof activityCounts>;
  onChange: (prefs: ActivityPrefs) => void;
}) {
  return (
    <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 px-1.5">
      <fieldset aria-label="Filter tool calls" className="flex min-w-0 flex-wrap gap-1">
        {ACTIVITY_FILTERS.map((filter) => (
          <button
            key={filter}
            type="button"
            data-testid={`chat-activity-filter-${filter}`}
            aria-pressed={prefs.filter === filter}
            onClick={() => onChange({ ...prefs, filter })}
            className={filterButtonClass(prefs.filter === filter)}
          >
            {ACTIVITY_FILTER_LABELS[filter]}
            <span data-testid="chat-activity-filter-count" className="tabular-nums text-outline">
              {counts[filter]}
            </span>
          </button>
        ))}
      </fieldset>
      <button
        type="button"
        data-testid="chat-activity-hide-successful"
        aria-pressed={prefs.hideSuccessful}
        onClick={() => onChange({ ...prefs, hideSuccessful: !prefs.hideSuccessful })}
        className={filterButtonClass(prefs.hideSuccessful)}
      >
        <EyeOff aria-hidden="true" size={12} />
        Hide successful
      </button>
      <HelpPopover label="activity filters" testId="chat-activity-help">
        Filters narrow this turn's tool calls. Thinking, plans and status messages stay visible, and
        the collapsed summary always counts every failure.
      </HelpPopover>
    </div>
  );
}

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
  const [prefs, setPrefs] = useState<ActivityPrefs>(readPrefs);
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
  const counts = useMemo(() => activityCounts(items), [items]);
  const visible = useMemo(() => filterActivity(items, prefs), [items, prefs]);
  if (!items.length && outcome !== "stopped" && outcome !== "failed") return null;
  const summary = foldSummary(fold, live, outcome);
  const update = (next: ActivityPrefs) => {
    setPrefs(next);
    storePrefs(next);
  };
  return (
    <details
      data-testid="chat-turn-fold"
      data-live={live || undefined}
      data-failed={fold.failed > 0 || undefined}
      className="group/fold mb-1 text-xs text-on-surface-variant"
    >
      <summary
        data-testid="chat-turn-fold-summary"
        className="flex min-h-7 w-fit max-w-full cursor-pointer list-none items-center gap-2 rounded-md px-1.5 hover:bg-surface hover:text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-sm:min-h-11 [&::-webkit-details-marker]:hidden"
      >
        <span data-testid="chat-turn-fold-label" className="min-w-0 truncate">
          {summary.text}
        </span>
        {summary.failure && (
          <span className="flex shrink-0 items-center gap-1 text-error">
            <CircleAlert aria-hidden="true" size={12} />
            {summary.failure}
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
        {fold.tools > 0 && <ActivityFilters prefs={prefs} counts={counts} onChange={update} />}
        {visible.map((item) => (
          <ActivityRow key={item.id} item={item} live={live} />
        ))}
        {fold.tools > 0 && visible.every((item) => item.type !== "tool") && (
          <p
            data-testid="chat-activity-empty"
            className="flex flex-wrap items-center gap-2 px-1.5 py-1"
          >
            No tool calls match this filter.
            <button
              type="button"
              onClick={() => update({ ...prefs, filter: "all", hideSuccessful: false })}
              className="min-h-8 rounded-md px-1.5 text-primary hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-lg:min-h-11"
            >
              Show all
            </button>
          </p>
        )}
      </section>
    </details>
  );
}
