import { RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { LiveSession } from "@/api/client";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Highlight } from "@/components/Highlight";
import { LiveSessionDetail } from "@/components/LiveSessionDetail";
import { Pager } from "@/components/Pager";
import { ResumeActions } from "@/components/ResumeActions";
import { SessionTaskLink } from "@/components/SessionTaskLink";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useBreakpoint } from "@/hooks/useMediaQuery";
import { useProjects } from "@/hooks/useProjects";
import { useLiveSessions, useSessionSearch, useSyncSessions } from "@/hooks/useSessions";
import { formatTokens, formatWhen, STATUS } from "@/lib/live-sessions";

const AGENTS = ["claude", "codex", "cursor", "cursor-agent", "gemini"];
const PAGE_SIZE = 25;
const HEAD = "font-label text-xs font-medium text-outline";

type Row = LiveSession & { snippets?: string[]; matched?: string[] };

export function LiveSessions({ projectId }: { projectId: string }) {
  const desktop = useBreakpoint("sm");
  const [params, setParams] = useSearchParams();
  const agent = params.get("agent") ?? "";
  const showEnded = params.get("ended") !== "0";
  const query = params.get("q") ?? "";
  const order = params.get("order") === "asc" ? "asc" : "desc";
  const openId = params.get("session");
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
  const list = useLiveSessions(!showEnded);
  const search = useSessionSearch(searching ? query.trim() : "", agent);
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
  const visible = byAgent
    .filter((s) =>
      projectId === "all"
        ? true
        : projectId === "unassigned"
          ? s.project_id === null
          : s.project_id === projectId,
    )
    .sort((a, b) => {
      const compared =
        new Date(a.last_activity_at ?? a.created_at).getTime() -
        new Date(b.last_activity_at ?? b.created_at).getTime();
      const result = compared || a.id.localeCompare(b.id);
      return order === "asc" ? result : -result;
    });
  const pageStart =
    Math.min(page, Math.max(0, Math.ceil(visible.length / PAGE_SIZE) - 1)) * PAGE_SIZE;
  const scopeName =
    projectId === "unassigned" ? "unassigned" : (projectName.get(projectId) ?? projectId);

  return (
    <section className="mb-8" data-testid="live-sessions">
      <p className="mb-4 text-sm text-outline">
        Discovered from your coding agents. Working sessions update automatically; waiting sessions
        remain available to resume.
      </p>
      <div className="mb-3 relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-outline" />
        <input
          data-testid="session-search"
          aria-label="Search agent sessions"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Search agent sessions: titles, summaries and conversation text"
          className="w-full bg-background border border-control-border rounded-lg pl-9 pr-3 py-2 font-body text-xs text-on-surface placeholder:text-outline"
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h2 className="font-label text-xs font-medium text-outline">
          {searching ? "Search results" : "Agent sessions"} · {visible.length}
          {visible.length !== byAgent.length && (
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
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          <select
            aria-label="Sort sessions by date"
            data-testid="session-date-sort"
            value={order}
            onChange={(event) => setParam("order", event.target.value === "asc" ? "asc" : null)}
            className="min-h-11 rounded-md border border-control-border bg-background px-3 text-sm text-on-surface"
          >
            <option value="desc">Last active: newest first</option>
            <option value="asc">Last active: oldest first</option>
          </select>
          <select
            data-testid="agent-filter"
            aria-label="Agent"
            className="bg-background border border-control-border rounded-lg min-h-11 px-3 py-2 font-label text-xs font-medium text-on-surface"
            value={agent}
            onChange={(e) => setParam("agent", e.target.value || null)}
          >
            <option value="">all agents</option>
            {agents.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          {
            <label className="flex items-center gap-2 font-label text-xs font-medium text-outline cursor-pointer">
              <input
                type="checkbox"
                data-testid="show-ended"
                checked={showEnded}
                onChange={(e) => setParam("ended", e.target.checked ? "1" : "0")}
              />
              Show ended
            </label>
          }
          <button
            type="button"
            data-testid="sync-sessions"
            disabled={sync.isPending}
            className="min-h-11 px-2 inline-flex items-center gap-1 font-label text-xs font-medium text-primary hover:text-on-surface disabled:opacity-50"
            onClick={() => sync.mutate()}
          >
            <RefreshCw className={`h-3 w-3 ${sync.isPending ? "animate-spin" : ""}`} />
            {sync.isPending ? "Syncing" : "Refresh"}
          </button>
        </div>
      </div>
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
            searching
              ? "No sessions match"
              : "No active agent sessions. Enable Show ended to browse previous conversations."
          }
        />
      ) : (
        <div className="min-w-0 overflow-hidden">
          {!desktop ? (
            <div className="divide-y divide-border">
              {visible.slice(pageStart, pageStart + PAGE_SIZE).map((session) => {
                return (
                  <article
                    key={session.id}
                    data-testid="live-session-row"
                    data-session-id={session.session_id}
                    data-agent={session.agent}
                    className="py-4 space-y-3"
                  >
                    <button
                      type="button"
                      className="text-left text-sm font-medium break-words hover:text-primary"
                      onClick={() => setParam("session", session.id)}
                    >
                      <Highlight
                        text={session.name ?? "Untitled session"}
                        query={searching ? query : ""}
                      />
                    </button>
                    <div className="flex flex-wrap gap-3 text-xs text-outline">
                      <span className="text-primary">{session.agent}</span>
                      <span data-testid="live-status">
                        {session.handoff?.status === "ready"
                          ? "Ready"
                          : STATUS[session.status].label}
                      </span>
                      <span data-testid="live-tokens">{formatTokens(session)} tokens</span>
                      <span>{formatWhen(session.last_activity_at)}</span>
                    </div>
                    {session.summary && (
                      <p className="text-sm text-outline break-words">
                        <Highlight text={session.summary} query={searching ? query : ""} />
                      </p>
                    )}
                    {session.snippets?.map((snippet) => (
                      <p
                        key={snippet}
                        data-testid="search-snippet"
                        className="text-xs break-words text-on-surface-variant"
                      >
                        <Highlight text={snippet} query={query} />
                      </p>
                    ))}
                    <p className="text-xs text-outline break-all">
                      {(session.project_id && projectName.get(session.project_id)) || "Unassigned"}
                      {session.cwd ? ` · ${session.cwd}` : ""}
                    </p>
                    <SessionTaskLink session={session} />
                    <ResumeActions session={session} />
                  </article>
                );
              })}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-b border-border hover:bg-transparent">
                  <TableHead className={`${HEAD} w-40`}>Status</TableHead>
                  <TableHead className={`${HEAD} w-20`}>Agent</TableHead>
                  <TableHead className={HEAD}>Session</TableHead>
                  <TableHead className={`${HEAD} w-28`}>Project</TableHead>
                  <TableHead className={`${HEAD} w-20 text-right`}>Tokens</TableHead>
                  <TableHead className={`${HEAD} w-36`}>Last active</TableHead>
                  <TableHead className={`${HEAD} w-56`}>Task</TableHead>
                  <TableHead className={`${HEAD} w-24`} />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.slice(pageStart, pageStart + PAGE_SIZE).map((s) => {
                  const st = STATUS[s.status];
                  return (
                    <TableRow
                      key={s.id}
                      data-testid="live-session-row"
                      data-session-id={s.session_id}
                      data-agent={s.agent}
                      className="border-b border-border/65 cursor-pointer hover:bg-surface-high"
                      onClick={(event) => {
                        if (
                          (event.target as HTMLElement).closest("button, a, input, [role='dialog']")
                        )
                          return;
                        setParam("session", s.id);
                      }}
                    >
                      <TableCell className="font-label text-xs text-on-surface">
                        <span className="inline-flex items-center gap-2" data-testid="live-status">
                          <span className={`h-2 w-2 rounded-full ${st.dot}`} />
                          {s.handoff?.status === "ready" ? "Ready" : st.label}
                        </span>
                      </TableCell>
                      <TableCell className="font-label text-xs font-medium text-primary">
                        {s.agent}
                      </TableCell>
                      <TableCell className="max-w-md">
                        <button
                          type="button"
                          className="block max-w-full text-left font-body text-sm font-medium text-on-surface truncate hover:text-primary"
                          onClick={(event) => {
                            event.stopPropagation();
                            setParam("session", s.id);
                          }}
                        >
                          <Highlight
                            text={s.name ?? "Untitled session"}
                            query={searching ? query : ""}
                          />
                        </button>
                        {s.summary && s.summary !== s.name && (
                          <div
                            className="font-body text-xs text-outline truncate"
                            title={s.summary}
                          >
                            <Highlight text={s.summary} query={searching ? query : ""} />
                          </div>
                        )}
                        {s.snippets?.map((snippet) => (
                          <div
                            key={snippet}
                            data-testid="search-snippet"
                            className="font-mono text-xs text-on-surface-variant truncate"
                            title={snippet}
                          >
                            <Highlight text={snippet} query={query} />
                          </div>
                        ))}
                        <div
                          className="font-label text-xs text-outline truncate"
                          title={s.cwd ?? undefined}
                        >
                          {s.cwd ?? ""}
                        </div>
                      </TableCell>
                      <TableCell className="font-label text-xs text-outline">
                        {(s.project_id && projectName.get(s.project_id)) || "—"}
                      </TableCell>
                      <TableCell
                        data-testid="live-tokens"
                        className="font-body text-xs text-on-surface-variant text-right"
                      >
                        {formatTokens(s)}
                      </TableCell>
                      <TableCell className="font-body text-xs text-on-surface-variant">
                        {formatWhen(s.last_activity_at)}
                      </TableCell>
                      <TableCell>
                        <SessionTaskLink session={s} />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="inline-flex items-center gap-3">
                          <ResumeActions session={s} />
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          <Pager
            page={pageStart / PAGE_SIZE}
            pageSize={PAGE_SIZE}
            total={visible.length}
            onPage={setPage}
          />
        </div>
      )}
      <LiveSessionDetail
        key={openId ?? "closed"}
        sessionId={openId}
        initialQuery={searching ? query.trim() : ""}
        onClose={() => setParam("session", null)}
      />
    </section>
  );
}
