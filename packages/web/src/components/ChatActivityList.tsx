import {
  buildChatItems,
  ChatProviderActivitySchema,
  ChatTurnSchema,
  readChatActivity,
} from "@orc/core/chat";
import { Bot, ChevronRight, CircleAlert, EyeOff } from "lucide-react";
import { useMemo, useState } from "react";
import { ActivityRow } from "@/components/chat-ui/tool-renderers";
import { HelpPopover } from "@/components/HelpPopover";
import { useOpenLiveSession } from "@/hooks/useOpenLiveSession";
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
  windowChatItems,
} from "@/lib/chat-activity";
import type { SessionSubagent } from "@/lib/subagent-links";
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
        Filters narrow this turn's tool calls. Thinking, plans, status messages and unrecognized
        activities stay visible, and the collapsed summary always counts every failure.
      </HelpPopover>
    </div>
  );
}

const SUBAGENT_STATUS: Record<string, string> = {
  running: "Working",
  idle: "Idle",
  stopped: "Done",
  error: "Failed",
};

function SubagentRows({ items }: { items: SessionSubagent[] }) {
  const openSession = useOpenLiveSession();
  const [error, setError] = useState<string | null>(null);
  if (!items.length) return null;
  async function open(id: string): Promise<void> {
    setError(null);
    try {
      await openSession(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The subagent could not be opened.");
    }
  }
  return (
    <ul data-testid="chat-subagents" className="mb-1 space-y-0.5">
      {items.map((subagent) => (
        <li key={subagent.id}>
          <button
            type="button"
            data-testid="chat-subagent"
            data-status={subagent.status}
            onClick={() => void open(subagent.id)}
            className="flex min-h-7 w-fit max-w-full items-center gap-2 rounded-md px-1.5 text-xs text-on-surface-variant hover:bg-surface hover:text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-sm:min-h-11"
          >
            <Bot aria-hidden="true" size={13} className="shrink-0" />
            <span className="min-w-0 truncate">{subagent.title}</span>
            <span
              className={cn(
                "shrink-0 text-[11px]",
                subagent.status === "running" ? "text-primary" : "text-outline",
                subagent.status === "error" && "text-error",
              )}
            >
              {SUBAGENT_STATUS[subagent.status] ?? subagent.status}
            </span>
            <ChevronRight aria-hidden="true" size={13} className="shrink-0" />
          </button>
        </li>
      ))}
      {error && (
        <li role="alert" className="px-1.5 text-xs text-error">
          {error}
        </li>
      )}
    </ul>
  );
}

export function ChatActivityList({
  value,
  providerActivity,
  turn,
  live = false,
  subagents,
}: {
  value: unknown;
  providerActivity?: unknown;
  turn?: unknown;
  live?: boolean;
  subagents?: ReadonlyMap<string, SessionSubagent>;
}) {
  const items = useMemo(() => {
    // The tolerant reader splits kinds this build knows from the ones it keeps
    // verbatim, so raw stored activity and already-split activity both work.
    const stored = readChatActivity(value);
    const provider = Array.isArray(providerActivity)
      ? providerActivity.flatMap((item) => {
          const parsed = ChatProviderActivitySchema.safeParse(item);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
    return buildChatItems({
      activity: stored.activity,
      providerActivity: [...stored.provider, ...provider],
    });
  }, [value, providerActivity]);
  const [prefs, setPrefs] = useState<ActivityPrefs>(readPrefs);
  const timing = ChatTurnSchema.safeParse(turn);
  const start = timing.success ? timing.data.startedAt : undefined;
  const end = timing.success ? timing.data.finishedAt : undefined;
  const durationMs = timing.success ? timing.data.durationMs : undefined;
  const outcome = timing.success ? timing.data.outcome : undefined;
  // A subagent's own transcript and the tool call that started it are shown as
  // first-class rows, never folded into the turn's tool summary: the call's result
  // is only "started", while the child's real work and answer live beside it.
  const subagentItems = useMemo(() => items.filter((item) => item.kind === "subagent"), [items]);
  const foldItems = useMemo(
    () =>
      items.filter(
        (item) => item.kind !== "subagent" && !(item.kind === "tool" && subagents?.has(item.id)),
      ),
    [items, subagents],
  );
  const inlineSubagents = useMemo(
    () => new Set(subagentItems.map((item) => item.id)),
    [subagentItems],
  );
  const fold = useMemo(
    () =>
      foldTurn(foldItems, {
        ...(start !== undefined ? { startedAt: start } : {}),
        ...(end !== undefined ? { finishedAt: end } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      }),
    [foldItems, start, end, durationMs],
  );
  const counts = useMemo(() => activityCounts(foldItems), [foldItems]);
  const started = useMemo(
    () =>
      items.flatMap((item) => {
        const subagent = item.kind === "tool" ? subagents?.get(item.id) : undefined;
        // The inline transcript already names this child; one row is enough.
        return subagent && (!subagent.session_id || !inlineSubagents.has(subagent.session_id))
          ? [subagent]
          : [];
      }),
    [items, subagents, inlineSubagents],
  );
  const visible = useMemo(() => filterActivity(foldItems, prefs), [foldItems, prefs]);
  // The window belongs to this turn only: the fold instance is the message's.
  const [showAll, setShowAll] = useState(false);
  const windowed = windowChatItems(visible, showAll);
  if (!items.length && outcome !== "stopped" && outcome !== "failed") return null;
  const summary = foldSummary(fold, live, outcome);
  const showFold = foldItems.length > 0 || outcome === "stopped" || outcome === "failed";
  const update = (next: ActivityPrefs) => {
    setPrefs(next);
    storePrefs(next);
  };
  return (
    <>
      {showFold && (
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
            {windowed.hidden > 0 && (
              <button
                type="button"
                data-testid="chat-items-show-all"
                onClick={() => setShowAll(true)}
                className="mb-1 min-h-8 rounded-md px-1.5 text-primary hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-lg:min-h-11"
              >
                Show all {visible.length} activities
              </button>
            )}
            {windowed.shown.map((item) => (
              <ActivityRow key={`${item.ordinal}-${item.id}`} item={item} live={live} />
            ))}
            {fold.tools > 0 && visible.every((item) => item.kind !== "tool") && (
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
      )}
      {subagentItems.map((item) => (
        <ActivityRow key={`${item.ordinal}-${item.id}`} item={item} live={live} />
      ))}
      <SubagentRows items={started} />
    </>
  );
}
