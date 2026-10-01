import { RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { LiveSession } from "@/api/client";
import { EmptyState } from "@/components/EmptyState";
import { Highlight } from "@/components/Highlight";
import { LiveSessionDetail } from "@/components/LiveSessionDetail";
import { ResumeActions } from "@/components/ResumeActions";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useProjects } from "@/hooks/useProjects";
import {
  useLinkSessionTask,
  useLiveSessions,
  useSessionSearch,
  useSyncSessions,
} from "@/hooks/useSessions";
import { useTasks } from "@/hooks/useTasks";
import { formatTokens, formatWhen, STATUS } from "@/lib/live-sessions";

const AGENTS = ["claude", "codex", "cursor"];
const PAGE_SIZE = 200;
const HEAD = "font-label text-[11px] uppercase tracking-widest text-outline";

type Row = LiveSession & { snippets?: string[]; matched?: string[] };

export function LiveSessions({ projectId }: { projectId: string }) {
  const [params, setParams] = useSearchParams();
  const agent = params.get("agent") ?? "";
  const showEnded = params.get("ended") === "1";
  const query = params.get("q") ?? "";
  const openId = params.get("session");
  const [draft, setDraft] = useState(query);
  const [shown, setShown] = useState(PAGE_SIZE);

  const setParam = useCallback(
    (key: string, value: string | null) => {
      setShown(PAGE_SIZE);
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value) next.set(key, value);
          else next.delete(key);
          return next;
        },
        { replace: true },
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
  const isLoading = searching ? search.isLoading : list.isLoading;
  const byAgent = source.filter((s) => !agent || s.agent === agent);
  const visible = byAgent.filter((s) =>
    projectId === "all"
      ? true
      : projectId === "unassigned"
        ? s.project_id === null
        : s.project_id === projectId,
  );
  const scopeName =
    projectId === "unassigned" ? "unassigned" : (projectName.get(projectId) ?? projectId);

  return (
    <section className="mb-8" data-testid="live-sessions">
      <div className="mb-3 relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-outline" />
        <input
          data-testid="session-search"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Search sessions: titles, summaries and conversation text across Claude, Codex and Cursor"
          className="w-full bg-surface-low border border-surface-highest rounded-sm pl-9 pr-3 py-2 font-body text-xs text-on-surface placeholder:text-outline"
        />
      </div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-label text-[11px] uppercase tracking-widest text-outline">
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
        <div className="flex items-center gap-4">
          <select
            data-testid="agent-filter"
            aria-label="Agent"
            className="bg-surface-low border border-surface-highest rounded-sm px-2 py-1 font-label text-[11px] uppercase tracking-widest text-on-surface"
            value={agent}
            onChange={(e) => setParam("agent", e.target.value || null)}
          >
            <option value="">all agents</option>
            {AGENTS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          {!searching && (
            <label className="flex items-center gap-2 font-label text-[11px] uppercase tracking-widest text-outline cursor-pointer">
              <input
                type="checkbox"
                checked={showEnded}
                onChange={(e) => setParam("ended", e.target.checked ? "1" : null)}
              />
              show ended
            </label>
          )}
          <button
            type="button"
            data-testid="sync-sessions"
            disabled={sync.isPending}
            className="inline-flex items-center gap-1 font-label text-[11px] uppercase tracking-widest text-primary hover:text-on-surface disabled:opacity-50"
            onClick={() => sync.mutate()}
          >
            <RefreshCw className={`h-3 w-3 ${sync.isPending ? "animate-spin" : ""}`} />
            {sync.isPending ? "Syncing" : "Refresh"}
          </button>
        </div>
      </div>
      {isLoading ? null : visible.length === 0 ? (
        <EmptyState message={searching ? "No sessions match" : "No sessions"} />
      ) : (
        <div className="border border-surface-highest rounded-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-surface-highest hover:bg-transparent">
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
              {visible.slice(0, shown).map((s) => {
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
                    className="border-b border-surface-highest/50 cursor-pointer hover:bg-surface-low"
                    onClick={() => setParam("session", s.id)}
                  >
                    <TableCell className="font-label text-xs">
                      <span className="inline-flex items-center gap-2" data-testid="live-status">
                        <span className={`h-2 w-2 rounded-full ${st.dot}`} />
                        {st.label}
                      </span>
                    </TableCell>
                    <TableCell className="font-label text-[11px] uppercase tracking-widest text-primary">
                      {s.agent}
                    </TableCell>
                    <TableCell className="max-w-md">
                      <div className="font-body text-xs text-on-surface truncate">
                        <Highlight text={s.name ?? "—"} query={searching ? query : ""} />
                      </div>
                      {s.summary && s.summary !== s.name && (
                        <div
                          className="font-body text-[11px] text-outline truncate"
                          title={s.summary}
                        >
                          <Highlight text={s.summary} query={searching ? query : ""} />
                        </div>
                      )}
                      {s.snippets?.map((snippet) => (
                        <div
                          key={snippet}
                          data-testid="search-snippet"
                          className="font-mono text-[11px] text-on-surface-variant truncate"
                          title={snippet}
                        >
                          <Highlight text={snippet} query={query} />
                        </div>
                      ))}
                      <div
                        className="font-label text-[11px] text-outline/70 truncate"
                        title={s.cwd ?? undefined}
                      >
                        {s.cwd ?? ""}
                      </div>
                    </TableCell>
                    <TableCell className="font-label text-[11px] text-outline">
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
                          className="w-full bg-surface-low border border-surface-highest rounded-sm px-2 py-1 font-body text-xs text-on-surface"
                          value={s.task?.id ?? ""}
                          disabled={link.isPending}
                          onChange={(e) =>
                            link.mutate({ id: s.id, taskId: e.target.value || null })
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
                            className="shrink-0 font-label text-[11px] uppercase tracking-widest text-primary hover:text-on-surface"
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
          {visible.length > shown && (
            <button
              type="button"
              data-testid="show-more-sessions"
              className="w-full py-3 font-label text-[11px] uppercase tracking-widest text-primary hover:text-on-surface"
              onClick={() => setShown((n) => n + PAGE_SIZE)}
            >
              Show {Math.min(PAGE_SIZE, visible.length - shown)} more ({visible.length - shown}{" "}
              remaining)
            </button>
          )}
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
