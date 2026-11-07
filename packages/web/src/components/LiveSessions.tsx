import { CODING_AGENTS } from "@orc/core/coding-agents";
import { RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { LiveSession } from "@/api/client";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Highlight } from "@/components/Highlight";
import { LiveSessionDetail } from "@/components/LiveSessionDetail";
import { Pager } from "@/components/Pager";
import { ResponsiveFilters } from "@/components/ResponsiveFilters";
import { ResumeActions } from "@/components/ResumeActions";
import { SessionHomeLink } from "@/components/SessionHomeLink";
import { SessionStateFilters, StableOrderPill } from "@/components/SessionListControls";
import {
  SessionRowContent,
  sessionRowButtonClass,
  sessionRowClass,
} from "@/components/SessionRowContent";
import { SessionTaskLink } from "@/components/SessionTaskLink";
import { Button } from "@/components/ui/button";
import { ViewHeader } from "@/components/ViewHeader";
import { useProjects } from "@/hooks/useProjects";
import { useSessionSeen } from "@/hooks/useSessionSeen";
import { useLiveSessions, useSessionSearch, useSyncSessions } from "@/hooks/useSessions";
import { useStableOrder } from "@/hooks/useStableOrder";
import { type AgentState, liveSessionState } from "@/lib/agent-state";
import { formatTokens, formatWhen } from "@/lib/live-sessions";
import { filterCounts, matchesFilter, parseFilter } from "@/lib/session-filter";
import { lastSeen, markSeen, unseenState } from "@/lib/session-seen";

const AGENTS = [...CODING_AGENTS.flatMap((agent) => agent.sessionBackends), "cursor"];
const PAGE_SIZE = 25;

type Row = LiveSession & { snippets?: string[]; matched?: string[] };

export function LiveSessions({ projectId }: { projectId: string }) {
  const [params, setParams] = useSearchParams();
  const agent = params.get("agent") ?? "";
  const showEnded = params.get("ended") !== "0";
  const query = params.get("q") ?? "";
  const order = params.get("order") === "asc" ? "asc" : "desc";
  const openId = params.get("session");
  const stateFilter = parseFilter(params.get("state"));
  const [draft, setDraft] = useState(query);
  const [pagination, setPagination] = useState({ order, page: 0 });
  const page = pagination.order === order ? pagination.page : 0;
  const setPage = useCallback((page: number) => setPagination({ order, page }), [order]);

  const setParam = useCallback(
    (key: string, value: string | null) => {
      setPage(0);
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value) next.set(key, value);
          else next.delete(key);
          return next;
        },
        { replace: key === "q" },
      );
    },
    [setParams, setPage],
  );

  useEffect(() => setDraft(query), [query]);
  useEffect(() => {
    if (draft === query) return;
    const t = setTimeout(() => setParam("q", draft.trim() || null), 350);
    return () => clearTimeout(t);
  }, [draft, query, setParam]);

  const searching = query.trim().length >= 2;
  const scopedProject = projectId === "all" ? undefined : projectId;
  const list = useLiveSessions(!showEnded, scopedProject);
  const search = useSessionSearch(searching ? query.trim() : "", agent, scopedProject);
  const { data: projects } = useProjects();
  const sync = useSyncSessions();

  const projectName = new Map((projects ?? []).map((p) => [p.id, p.name]));

  const source: Row[] = searching ? (search.data?.hits ?? []) : (list.data ?? []);
  const agents = [...new Set([...AGENTS, ...source.map((session) => session.agent)])];
  const isLoading = searching ? search.isLoading : list.isLoading;
  const result = searching ? search : list;
  const byAgent = source.filter(
    (s) =>
      (!agent || s.agent === agent) &&
      (showEnded || s.status !== "stopped" || s.handoff?.status === "ready"),
  );
  const seen = useSessionSeen();
  useEffect(() => {
    if (!openId) return;
    const keys = [`native:${openId}`];
    markSeen(keys);
    return () => markSeen(keys);
  }, [openId]);
  const activity = (s: Row) => new Date(s.last_activity_at ?? s.created_at).getTime();
  const states = new Map<string, AgentState>(
    byAgent.map((s) => [
      s.id,
      s.id === openId
        ? liveSessionState(s)
        : unseenState(liveSessionState(s), activity(s), lastSeen(seen, [`native:${s.id}`])),
    ]),
  );
  const stateOf = (s: Row) => states.get(s.id) ?? liveSessionState(s);
  const scoped = byAgent.filter((s) =>
    projectId === "all"
      ? true
      : projectId === "unassigned"
        ? s.project_id === null
        : s.project_id === projectId,
  );
  const counts = filterCounts(scoped.map(stateOf));
  const byId = new Map(scoped.map((s) => [s.id, s]));
  const stable = useStableOrder({
    items: scoped
      .filter((s) => matchesFilter(stateOf(s), stateFilter))
      .sort((a, b) => {
        const compared =
          new Date(a.last_activity_at ?? a.created_at).getTime() -
          new Date(b.last_activity_at ?? b.created_at).getTime();
        const result = compared || a.id.localeCompare(b.id);
        return order === "asc" ? result : -result;
      }),
    id: (s) => s.id,
    version: (s) => String(activity(s)),
    lookup: (id) => byId.get(id),
    resetKey: [projectId, stateFilter, agent, showEnded, query, order].join("\n"),
    loading: isLoading,
  });
  const visible = stable.items;
  const pageStart =
    Math.min(page, Math.max(0, Math.ceil(visible.length / PAGE_SIZE) - 1)) * PAGE_SIZE;
  const scopeName =
    projectId === "unassigned" ? "unassigned" : (projectName.get(projectId) ?? projectId);

  return (
    <section className="mb-8" data-testid="live-sessions">
      <ViewHeader
        compact
        level={2}
        title={searching ? "Search results" : "Agent sessions"}
        help="Discovered from your coding agents. Working sessions update automatically; waiting sessions remain available to resume."
        meta={
          <>
            {visible.length}
            {scoped.length !== byAgent.length && (
              <span data-testid="scope-hint" className="normal-case tracking-normal">
                {" "}
                of {byAgent.length} · scope: {scopeName}
              </span>
            )}
            {searching && search.data && (
              <span data-testid="search-meta" className="normal-case tracking-normal">
                {" "}
                · {(search.data.ms / 1000).toFixed(1)}s
                {search.data.rg ? "" : " · titles and summaries only (install ripgrep for content)"}
              </span>
            )}
          </>
        }
        action={
          <div className="flex items-center gap-1">
            <SessionHomeLink label="Open sessions view" testId="live-sessions-open-home" />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={sync.isPending ? "Syncing sessions" : "Refresh sessions"}
              title="Refresh sessions"
              data-testid="sync-sessions"
              disabled={sync.isPending}
              className="lg:size-8"
              onClick={() => sync.mutate()}
            >
              <RefreshCw className={sync.isPending ? "animate-spin" : ""} />
            </Button>
          </div>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 lg:max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-outline" />
          <input
            type="search"
            data-testid="session-search"
            aria-label="Search agent sessions"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Search agent sessions…"
            className="h-11 w-full rounded-md border border-control-border bg-background pl-9 pr-3 font-body text-base text-on-surface placeholder:text-outline lg:h-8 lg:text-[13px]"
          />
        </div>
        <ResponsiveFilters
          activeCount={Number(Boolean(agent)) + Number(!showEnded) + Number(order === "asc")}
        >
          <select
            aria-label="Sort sessions by date"
            data-testid="session-date-sort"
            value={order}
            onChange={(event) => setParam("order", event.target.value === "asc" ? "asc" : null)}
            className="h-11 max-w-full rounded-md border border-control-border bg-background px-3 text-base text-on-surface lg:h-8 lg:text-[13px]"
          >
            <option value="desc">Last active: newest</option>
            <option value="asc">Last active: oldest</option>
          </select>
          <select
            data-testid="agent-filter"
            aria-label="Agent"
            className="h-11 max-w-full rounded-md border border-control-border bg-background px-3 text-base text-on-surface lg:h-8 lg:text-[13px]"
            value={agent}
            onChange={(e) => setParam("agent", e.target.value || null)}
          >
            <option value="">All agents</option>
            {agents.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          {
            <label className="flex min-h-11 cursor-pointer items-center gap-2 text-[13px] text-outline lg:min-h-8">
              <input
                type="checkbox"
                data-testid="show-ended"
                checked={showEnded}
                onChange={(e) => setParam("ended", e.target.checked ? "1" : "0")}
              />
              Show ended
            </label>
          }
        </ResponsiveFilters>
      </div>
      <div {...stable.listProps}>
        {searching ? (
          <StableOrderPill pending={stable.pending} onApply={stable.apply} />
        ) : (
          <SessionStateFilters
            className="mb-3"
            value={stateFilter}
            counts={counts}
            onChange={(filter) => setParam("state", filter === "all" ? null : filter)}
          >
            <StableOrderPill pending={stable.pending} onApply={stable.apply} />
          </SessionStateFilters>
        )}
        {sync.error && (
          <p role="alert" className="mb-3 text-sm text-error">
            {sync.error.message}
          </p>
        )}
        {result.error ? (
          <ErrorState message={result.error.message} onRetry={() => result.refetch()} />
        ) : isLoading ? (
          <p role="status" className="py-8 text-sm text-outline">
            Loading sessions…
          </p>
        ) : visible.length === 0 ? (
          <EmptyState
            message={
              searching || stateFilter !== "all"
                ? "No sessions match"
                : "No active agent sessions. Enable Show ended to browse previous conversations."
            }
          />
        ) : (
          <div className="min-w-0 overflow-hidden">
            <div className="divide-y divide-border" data-testid="live-session-list">
              {visible.slice(pageStart, pageStart + PAGE_SIZE).map((session) => (
                <article
                  key={session.id}
                  data-testid="live-session-row"
                  data-session-id={session.session_id}
                  data-agent={session.agent}
                  data-state={stateOf(session)}
                  className="min-w-0 py-1"
                >
                  <div className={`${sessionRowClass} hover:bg-surface`}>
                    <button
                      type="button"
                      className={sessionRowButtonClass}
                      onClick={() => setParam("session", session.id)}
                    >
                      <SessionRowContent
                        agent={session.agent}
                        title={
                          <Highlight
                            text={session.name ?? "Untitled session"}
                            query={searching ? query : ""}
                          />
                        }
                        state={stateOf(session)}
                        stateTestId="live-status"
                        compact={false}
                      />
                    </button>
                  </div>
                  <div className="grid min-w-0 grid-cols-1 items-center gap-x-3 gap-y-1 pb-1 pl-9 pr-2 text-xs text-on-surface-variant sm:grid-cols-[minmax(0,1fr)_auto]">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 sm:col-start-1">
                      <span>{session.agent}</span>
                      <span data-testid="live-tokens">{formatTokens(session)} tokens</span>
                      <span>{formatWhen(session.last_activity_at)}</span>
                      <span>
                        {session.project_id
                          ? (projectName.get(session.project_id) ?? "Unknown project")
                          : "Unassigned"}
                      </span>
                      {session.handoff?.status === "ready" && (
                        <span data-testid="handoff-ready">Ready to resume</span>
                      )}
                    </div>
                    {session.summary && session.summary !== session.name && (
                      <p className="truncate sm:col-start-1" title={session.summary}>
                        <Highlight text={session.summary} query={searching ? query : ""} />
                      </p>
                    )}
                    {session.snippets?.map((snippet) => (
                      <p
                        key={snippet}
                        data-testid="search-snippet"
                        className="wrap-break-word sm:col-start-1"
                      >
                        <Highlight text={snippet} query={query} />
                      </p>
                    ))}
                    {session.cwd && (
                      <p className="truncate sm:col-start-1" title={session.cwd}>
                        {session.cwd}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 sm:col-start-2 sm:row-start-1 sm:row-span-3 sm:justify-end">
                      <SessionTaskLink session={session} />
                      <ResumeActions session={session} />
                      <SessionHomeLink
                        liveId={session.id}
                        label="Open in sessions view"
                        testId="live-session-open-home"
                      />
                    </div>
                  </div>
                </article>
              ))}
            </div>
            <Pager
              page={pageStart / PAGE_SIZE}
              pageSize={PAGE_SIZE}
              total={visible.length}
              onPage={setPage}
            />
          </div>
        )}
      </div>
      <LiveSessionDetail
        key={openId ?? "closed"}
        sessionId={openId}
        initialQuery={searching ? query.trim() : ""}
        onClose={() => setParam("session", null)}
      />
    </section>
  );
}
