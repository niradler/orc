import { useSessions } from "@/hooks/useSessions";
import { ViewHeader } from "@/components/ViewHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";

export default function Sessions() {
  const { data: sessions, isLoading, error, refetch } = useSessions({ limit: 50 });

  if (error) return <ErrorState message={(error as Error).message} onRetry={() => refetch()} />;

  return (
    <div>
      <ViewHeader title="Sessions" meta={`${(sessions ?? []).length} recent`} />

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-10 w-full bg-surface-highest" />)}
        </div>
      ) : (sessions ?? []).length === 0 ? (
        <EmptyState message="No sessions" />
      ) : (
        <div className="border border-surface-highest rounded-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-surface-highest hover:bg-transparent">
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-16">ID</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">Agent</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">Summary</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">Version</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-36">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(sessions ?? []).map((s) => (
                <TableRow key={s.id} className="border-b border-surface-highest/50 hover:bg-surface-low">
                  <TableCell className="font-label text-[10px] text-outline">{s.id.slice(-6)}</TableCell>
                  <TableCell className="font-label text-xs text-primary">{s.agent ?? "—"}</TableCell>
                  <TableCell className="font-body text-xs text-on-surface-variant max-w-sm truncate">
                    {s.summary ?? "—"}
                  </TableCell>
                  <TableCell className="font-label text-[10px] text-outline">{s.agent_version ?? "—"}</TableCell>
                  <TableCell className="font-label text-[10px] text-outline">
                    {new Date(s.created_at).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
