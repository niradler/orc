import {
  buildChatItems,
  ChatProviderActivitySchema,
  ChatTurnSchema,
  readChatActivity,
} from "@orc/core/chat";
import { ChevronRight, CircleAlert, EyeOff } from "lucide-react";
import { useMemo, useState } from "react";
import { SubagentList } from "@/components/ChatControls";
import { ActivityRow } from "@/components/chat-ui/tool-renderers";
import { HelpPopover } from "@/components/HelpPopover";
import { useNow } from "@/hooks/useNow";
import { useOpenLiveSession } from "@/hooks/useOpenLiveSession";
import { AGENT_STATES } from "@/lib/agent-state";
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
  formatDuration,
  parseActivityPrefs,
  windowChatItems,
} from "@/lib/chat-activity";
import { liveSubagentTree, type SubagentNode, subagentState } from "@/lib/subagent-links";
import { formatTokenCount } from "@/lib/token-count";
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

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function treeLabel(roots: readonly SubagentNode[]): string {
  const all = roots.flatMap(function walk(node): SubagentNode[] {
    return [node, ...node.children.flatMap(walk)];
  });
  const count = (status: SubagentNode["status"]) =>
    all.filter((node) => node.status === status).length;
  return [
    plural(all.length, "subagent"),
    count("waiting") ? `${count("waiting")} waiting` : "",
    count("failed") ? `${count("failed")} failed` : "",
    count("running") ? `${count("running")} running` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function NodeTime({ node }: { node: SubagentNode }) {
  const now = useNow();
  const ms =
    node.status === "running" && node.startedAt !== undefined
      ? now - node.startedAt
      : (node.durationMs ?? 0);
  return ms >= 1000 ? <span className="tabular-nums">{formatDuration(ms)}</span> : null;
}

function SubagentNodeRow({
  node,
  onOpen,
}: {
  node: SubagentNode;
  onOpen: (sessionId: string) => void;
}) {
  const state = subagentState(node);
  const { Icon, tone, spin, label } = AGENT_STATES[state];
  const content = (
    <>
      <Icon
        role="img"
        aria-label={label}
        size={13}
        className={cn("shrink-0", tone, spin && "motion-safe:animate-spin")}
      />
      <span className="min-w-0 truncate text-on-surface">{node.title}</span>
      <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-outline">
        {node.tokens ? (
          <span className="tabular-nums">{formatTokenCount(node.tokens, false)} tokens</span>
        ) : null}
        {node.status === "running" || node.durationMs !== undefined ? (
          <NodeTime node={node} />
        ) : null}
        {state === "needs-you" || state === "failed" ? <span className={tone}>{label}</span> : null}
      </span>
    </>
  );
  const row =
    "flex min-h-7 w-fit max-w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-xs text-on-surface-variant max-sm:min-h-11";
  return (
    <div data-testid="chat-subagent" data-status={node.status} data-state={state}>
      {node.sessionId ? (
        <button
          type="button"
          onClick={() => onOpen(node.sessionId as string)}
          className={cn(
            row,
            "text-left hover:bg-surface hover:text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
          )}
        >
          {content}
        </button>
      ) : (
        <div className={row}>{content}</div>
      )}
      {node.children.length > 0 && (
        <SubagentList
          label={plural(node.children.length, "subagent")}
          testId="chat-subagent-children"
          className="pl-4"
        >
          {node.children.map((child) => (
            <SubagentNodeRow key={child.id} node={child} onOpen={onOpen} />
          ))}
        </SubagentList>
      )}
    </div>
  );
}

function SubagentTree({ roots }: { roots: SubagentNode[] }) {
  const openSession = useOpenLiveSession();
  const [error, setError] = useState<string | null>(null);
  if (!roots.length) return null;
  async function open(id: string): Promise<void> {
    setError(null);
    try {
      await openSession(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The subagent could not be opened.");
    }
  }
  return (
    <div className="mb-1 min-w-0">
      <SubagentList label={treeLabel(roots)} testId="chat-subagents" className="pl-0">
        {roots.map((node) => (
          <SubagentNodeRow key={node.id} node={node} onOpen={(id) => void open(id)} />
        ))}
      </SubagentList>
      {error && (
        <p role="alert" className="px-1.5 text-xs text-error">
          {error}
        </p>
      )}
    </div>
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
  subagents?: ReadonlyMap<string, SubagentNode>;
}) {
  const stored = useMemo(() => readChatActivity(value), [value]);
  const items = useMemo(() => {
    // The tolerant reader splits kinds this build knows from the ones it keeps
    // verbatim, so raw stored activity and already-split activity both work.
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
  }, [stored, providerActivity]);
  const [prefs, setPrefs] = useState<ActivityPrefs>(readPrefs);
  const timing = ChatTurnSchema.safeParse(turn);
  const start = timing.success ? timing.data.startedAt : undefined;
  const end = timing.success ? timing.data.finishedAt : undefined;
  const durationMs = timing.success ? timing.data.durationMs : undefined;
  const outcome = timing.success ? timing.data.outcome : undefined;
  // The tool call that started a subagent only reports "started", so counting it
  // reads as a finished or incomplete tool beside the tree row that opens the
  // child. The call is left out of the summary; the child's own transcript stays.
  const foldItems = useMemo(
    () => items.filter((item) => !(item.kind === "tool" && subagents?.has(item.id))),
    [items, subagents],
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
  const tree = useMemo(() => {
    const live = liveSubagentTree(stored.activity);
    if (live.length) return live;
    return items.flatMap((item) => {
      const subagent = item.kind === "tool" ? subagents?.get(item.id) : undefined;
      return subagent ? [subagent] : [];
    });
  }, [stored, items, subagents]);
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
      <SubagentTree roots={tree} />
    </>
  );
}
