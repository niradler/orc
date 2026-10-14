import { RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { LiveSession } from "@/api/client";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Highlight } from "@/components/Highlight";
import { LiveSessionDetail } from "@/components/LiveSessionDetail";
import { Pager } from "@/components/Pager";
import { ResumeActions } from "@/components/ResumeActions";
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
import {
  useLinkSessionTask,
  useLiveSessions,
  useSessionSearch,
  useSyncSessions,
} from "@/hooks/useSessions";
import { useTasks } from "@/hooks/useTasks";
import { formatTokens, formatWhen, STATUS } from "@/lib/live-sessions";

const AGENTS = ["claude", "codex", "cursor", "cursor-agent", "gemini"];
const PAGE_SIZE = 25;
const HEAD = "font-label text-xs font-medium text-outline";

type Row = LiveSession & { snippets?: string[]; matched?: string[] };

export function LiveSessions({ projectId }: { projectId: string }) {
  const desktop = useBreakpoint("sm");
  const [params, setParams] = useSearchParams();
  const agent = params.get("agent") ?? "";
  const showEnded = params.get("ended") === "1";
  const query = params.get("q") ?? "";
  const openId = params.get("session");
  const [draft, setDraft] = useState(query);
  const [page, setPage] = useState(0);

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
    [setParams],
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
  const { data: tasks } = useTasks();
  const { data: projects } = useProjects();
  const link = useLinkSessionTask();
  const sync = useSyncSessions();

  const projectName = new Map((projects ?? []).map((p) => [p.id, p.name]));
  const openTasks = (tasks ?? []).filter((t) => t.status !== "done" && t.status !== "cancelled");

  const source: Row[] = searching ? (search.data?.hits ?? []) : (list.data ?? []);
  const agents = [...new Set([...AGENTS, ...source.map((session) => session.agent)])];
  const isLoading = searching ? search.isLoading : list.isLoading;
  const result = searching ? search : list;
  const byAgent = source.filter((s) => !agent || s.agent === agent);
  const visible = byAgent.filter((s) =>
    projectId === "all"
      ? true
      : projectId === "unassigned"
        ? s.project_id === null
        : s.project_id === projectId,
  );
  const pageStart =
    Math.min(page, Math.max(0, Math.ceil(visible.length / PAGE_SIZE) - 1)) * PAGE_SIZE;
  const scopeName =
    projectId === "unassigned" ? "unassigned" : (projectName.get(projectId) ?? projectId);

  return (
    <section className="mb-8" data-testid="live-sessions">
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
          {!searching && (
            <label className="flex items-center gap-2 font-label text-xs font-medium text-outline cursor-pointer">
              <input
                type="checkbox"
                checked={showEnded}
                onChange={(e) => setParam("ended", e.target.checked ? "1" : null)}
              />
              Show ended
            </label>
          )}
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
      {(sync.error || link.error) && (
        <p role="alert" className="mb-3 text-sm text-error">
          {(sync.error ?? link.error)?.message}
        </p>
      )}
      {result.error ? (
        <ErrorState message={result.error.message} onRetry={() => result.refetch()} />
      ) : isLoading ? (
        <p role="status" className="py-8 text-sm text-outline">
          Loading sessions…
        </p>
      ) : visible.length === 0 ? (
        <EmptyState message={searching ? "No sessions match" : "No sessions"} />
      ) : (
        <div className="min-w-0 overflow-hidden">
          {!desktop ? (
            <div className="divide-y divide-border">
              {visible.slice(pageStart, pageStart + PAGE_SIZE).map((session) => {
                const choices =
                  session.task && !openTasks.some((task) => task.id === session.task?.id)
                    ? [session.task, ...openTasks]
                    : openTasks;
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
                    <label className="block text-xs text-outline space-y-1">
                      <span>Linked task</span>
                      <select
                        data-testid="link-task"
                        aria-label="Link task"
                        className="block min-h-11 w-full rounded-md border border-control-border bg-background px-3 text-sm text-on-surface"
                        value={session.task?.id ?? ""}
                        disabled={link.isPending}
                        onChange={(event) =>
                          link.mutate({ id: session.id, taskId: event.target.value || null })
                        }
                      >
                        <option value="">No task</option>
                        {choices.map((task) => (
                          <option key={task.id} value={task.id}>
                            {task.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="flex flex-wrap items-center gap-3">
                      <ResumeActions session={session} />
                      {session.task && (
                        <Link
                          className="min-h-11 inline-flex items-center text-sm text-primary"
                          data-testid="open-task"
                          to={`/tasks/${session.task.id}`}
                        >
                          Open task
                        </Link>
                      )}
                    </div>
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
                  const choices =
                    s.task && !openTasks.some((t) => t.id === s.task?.id)
                      ? [{ id: s.task.id, title: s.task.title }, ...openTasks]
                      : openTasks;
                  return (
                    <TableRow
                      key={s.id}
                      data-testid="live-session-row"
                      data-session-id={s.session_id}
                      data-agent={s.agent}
                      className="border-b border-border/65 cursor-pointer hover:bg-surface-high"
                      onClick={() => setParam("session", s.id)}
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
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-2">
                          <select
                            data-testid="link-task"
                            aria-label="Link task"
                            className="w-full bg-background border border-control-border rounded-lg min-h-11 px-3 py-2 font-body text-xs text-on-surface"
                            value={s.task?.id ?? ""}
                            disabled={link.isPending}
                            onChange={(e) =>
                              link.mutate({
                                id: s.id,
                                taskId: e.target.value || null,
                              })
                            }
                          >
                            <option value="">No task</option>
                            {choices.map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.title}
                              </option>
                            ))}
                          </select>
                          {s.task && (
                            <Link
                              to={`/tasks/${s.task.id}`}
                              data-testid="open-task"
                              title={`Open task: ${s.task.title}`}
                              className="shrink-0 font-label text-xs font-medium text-primary hover:text-on-surface"
                            >
                              Open
                            </Link>
                          )}
                        </div>
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
