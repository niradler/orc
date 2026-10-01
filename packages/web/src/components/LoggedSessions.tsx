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
import { useLoggedSessions } from "@/hooks/useSessions";

const PAGE_SIZE = 25;
const HEAD = "font-label text-[11px] uppercase tracking-widest text-outline";

export function LoggedSessions({ projectId }: { projectId: string }) {
  const [page, setPage] = useState(0);
  const {
    selectedId: selected,
    openDetail,
    closeDetail,
  } = useDetailRoute("/sessions", "sessionId");
  const { data, isLoading, error, refetch } = useLoggedSessions({
    ...(projectId === "all" ? {} : { project_id: projectId }),
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });

  if (error) return <ErrorState message={(error as Error).message} onRetry={() => refetch()} />;

  const rows = data?.sessions ?? [];
  const total = data?.total ?? 0;

  return (
    <section data-testid="logged-sessions">
      {isLoading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <Skeleton key={i} className="h-10 w-full bg-surface-highest" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState message="No ORC sessions" />
      ) : (
        <div className="border border-surface-highest rounded-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-surface-highest hover:bg-transparent">
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
                  className="border-b border-surface-highest/50 hover:bg-surface-low cursor-pointer"
                  onClick={() => openDetail(s.id)}
                >
                  <TableCell className="font-label text-xs text-primary">
                    {s.agent ?? "—"}
                  </TableCell>
                  <TableCell className="font-label text-[11px] text-outline">
                    {s.agent_version ?? "—"}
                  </TableCell>
                  <TableCell className="font-body text-xs text-on-surface-variant max-w-sm truncate">
                    {s.summary ?? "—"}
                  </TableCell>
                  <TableCell className="font-label text-[11px] text-outline">
                    {s.project_id ? s.project_id.slice(-6) : "—"}
                  </TableCell>
                  <TableCell className="font-label text-[11px] text-outline text-right">
                    {s.tokens_used != null ? s.tokens_used.toLocaleString() : "—"}
                  </TableCell>
                  <TableCell className="font-label text-[11px] text-outline">
                    {new Date(s.created_at).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pager page={page} pageSize={PAGE_SIZE} total={total} onPage={setPage} />
        </div>
      )}

      <SessionDetailSheet sessionId={selected} open={Boolean(selected)} onClose={closeDetail} />
    </section>
  );
}
