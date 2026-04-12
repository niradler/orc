import { useMemo, useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
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
import { ViewHeader } from "@/components/ViewHeader";
import { useSessions } from "@/hooks/useSessions";

export default function Sessions({ projectId }: { projectId: string }) {
  const { data: sessions, isLoading, error, refetch } = useSessions({ limit: 50 });
  const [selected, setSelected] = useState<string | null>(null);

  const visible = useMemo(() => {
    const all = sessions ?? [];
    if (projectId === "all") return all;
    return all.filter((s) => s.project_id === projectId);
  }, [sessions, projectId]);

  if (error) return <ErrorState message={(error as Error).message} onRetry={() => refetch()} />;

  return (
    <div>
      <ViewHeader title="Sessions" meta={`${visible.length} recent`} />

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} className="h-10 w-full bg-surface-highest" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState message="No sessions" />
      ) : (
        <div className="border border-surface-highest rounded-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-surface-highest hover:bg-transparent">
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">
                  Agent
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">
                  Version
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">
                  Summary
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">
                  Project
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-28">
                  Tokens Used
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-36">
                  Created
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((s) => (
                <TableRow
                  key={s.id}
                  className="border-b border-surface-highest/50 hover:bg-surface-low cursor-pointer"
                  onClick={() => setSelected(s.id)}
                >
                  <TableCell className="font-label text-xs text-primary">
                    {s.agent ?? "\u2014"}
                  </TableCell>
                  <TableCell className="font-label text-[10px] text-outline">
                    {s.agent_version ?? "\u2014"}
                  </TableCell>
                  <TableCell className="font-body text-xs text-on-surface-variant max-w-sm truncate">
                    {s.summary ?? "\u2014"}
                  </TableCell>
                  <TableCell className="font-label text-[10px] text-outline">
                    {s.project_id ? s.project_id.slice(-6) : "\u2014"}
                  </TableCell>
                  <TableCell className="font-label text-[10px] text-outline text-right">
                    {s.tokens_used != null ? s.tokens_used.toLocaleString() : "\u2014"}
                  </TableCell>
                  <TableCell className="font-label text-[10px] text-outline">
                    {new Date(s.created_at).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <SessionDetailSheet
        sessionId={selected}
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}
