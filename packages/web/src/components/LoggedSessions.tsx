import { useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Pager } from "@/components/Pager";
import { SessionDetailSheet } from "@/components/SessionDetailSheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDetailRoute } from "@/hooks/useDetailRoute";
import { useBreakpoint } from "@/hooks/useMediaQuery";
import { useLoggedSessions } from "@/hooks/useSessions";
import { useViewParam } from "@/lib/view-params";

const PAGE_SIZE = 25;
const HEAD = "font-label text-xs font-medium text-outline";

export function LoggedSessions({ projectId }: { projectId: string }) {
  const desktop = useBreakpoint("sm");
  const [order, setOrder] = useViewParam<"asc" | "desc">("order", "desc", ["asc", "desc"]);
  const [pagination, setPagination] = useState({ order, page: 0 });
  const page = pagination.order === order ? pagination.page : 0;
  const setPage = (page: number) => setPagination({ order, page });
  const { selectedId: selected, openDetail, closeDetail } = useDetailRoute("/audit", "sessionId");
  const { data, isLoading, error, refetch } = useLoggedSessions({
    ...(projectId === "all" ? {} : { project_id: projectId }),
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    order,
  });

  if (error) return <ErrorState message={(error as Error).message} onRetry={() => refetch()} />;

  const rows = data?.sessions ?? [];
  const total = data?.total ?? 0;

  return (
    <section data-testid="logged-sessions">
      <div className="mb-4 flex justify-end">
        <select
          aria-label="Sort audit by date"
          data-testid="audit-date-sort"
          value={order}
          onChange={(event) => {
            setPage(0);
            setOrder(event.target.value as "asc" | "desc");
          }}
          className="min-h-11 rounded-md border border-control-border bg-background px-3 text-sm text-on-surface"
        >
          <option value="desc">Created: newest first</option>
          <option value="asc">Created: oldest first</option>
        </select>
      </div>
      {isLoading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <Skeleton key={i} className="h-10 w-full bg-surface-highest" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState message="No audit records" />
      ) : (
        <div className="min-w-0 overflow-hidden">
          {!desktop ? (
            <div className="divide-y divide-border">
              {rows.map((session) => (
                <article
                  key={session.id}
                  data-testid="session-row"
                  data-session-id={session.id}
                  className="py-4 space-y-3"
                >
                  <button
                    type="button"
                    className="min-h-11 text-sm text-left font-medium text-primary break-words"
                    onClick={() => openDetail(session.id)}
                  >
                    {session.agent ?? "Session"}
                  </button>
                  <p className="text-sm leading-relaxed text-on-surface break-words">
                    {session.summary ?? "No summary recorded"}
                  </p>
                  <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-outline">
                    <span>Version {session.agent_version ?? "—"}</span>
                    <span>{session.tokens_used?.toLocaleString() ?? "—"} tokens</span>
                    <span>
                      {session.project_id
                        ? `Project ${session.project_id.slice(-6)}`
                        : "Unassigned"}
                    </span>
                    <span>{new Date(session.created_at).toLocaleString()}</span>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-b border-border hover:bg-transparent">
                  <TableHead className={HEAD}>Agent</TableHead>
                  <TableHead className={`${HEAD} w-24`}>Version</TableHead>
                  <TableHead className={HEAD}>Summary</TableHead>
                  <TableHead className={`${HEAD} w-24`}>Project</TableHead>
                  <TableHead className={`${HEAD} w-28`}>Tokens Used</TableHead>
                  <TableHead className={`${HEAD} w-36`}>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((s) => (
                  <TableRow
                    key={s.id}
                    data-testid="session-row"
                    data-session-id={s.id}
                    className="border-b border-border/65 hover:bg-surface-high cursor-pointer"
                    onClick={() => openDetail(s.id)}
                  >
                    <TableCell className="font-label text-xs text-primary">
                      <button
                        type="button"
                        className="text-left font-medium hover:underline"
                        onClick={(event) => {
                          event.stopPropagation();
                          openDetail(s.id);
                        }}
                      >
                        {s.agent ?? "Session"}
                      </button>
                    </TableCell>
                    <TableCell className="font-label text-xs text-outline">
                      {s.agent_version ?? "—"}
                    </TableCell>
                    <TableCell className="font-body text-xs text-on-surface-variant max-w-sm truncate">
                      {s.summary ?? "—"}
                    </TableCell>
                    <TableCell className="font-label text-xs text-outline">
                      {s.project_id ? s.project_id.slice(-6) : "—"}
                    </TableCell>
                    <TableCell className="font-label text-xs text-outline text-right">
                      {s.tokens_used != null ? s.tokens_used.toLocaleString() : "—"}
                    </TableCell>
                    <TableCell className="font-label text-xs text-outline">
                      {new Date(s.created_at).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <Pager page={page} pageSize={PAGE_SIZE} total={total} onPage={setPage} />
        </div>
      )}

      <SessionDetailSheet sessionId={selected} open={Boolean(selected)} onClose={closeDetail} />
    </section>
  );
}
