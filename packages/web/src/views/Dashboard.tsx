import { useTasks } from "@/hooks/useTasks";
import { useJobs } from "@/hooks/useJobs";
import { useMemories } from "@/hooks/useMemories";
import { useProjects } from "@/hooks/useProjects";
import { StatCard } from "@/components/StatCard";
import { ViewHeader } from "@/components/ViewHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { PriorityBadge } from "@/components/PriorityBadge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import type { View } from "@/App";

interface DashboardProps {
  onNavigate: (view: View) => void;
}

export default function Dashboard({ onNavigate }: DashboardProps) {
  const { data: tasks, isLoading: tasksLoading } = useTasks();
  const { data: jobs } = useJobs();
  const { data: memories } = useMemories();
  const { data: projects } = useProjects();

  const byStatus = (tasks ?? []).reduce(
    (acc, t) => { acc[t.status] = (acc[t.status] ?? 0) + 1; return acc; },
    {} as Record<string, number>,
  );

  const recent = [...(tasks ?? [])]
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, 8);

  return (
    <div>
      <ViewHeader title="Dashboard" />

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
        <StatCard
          label="Doing"
          value={byStatus["doing"] ?? 0}
          accent="primary"
          sub="in progress"
          onClick={() => onNavigate("tasks")}
        />
        <StatCard
          label="Review"
          value={byStatus["review"] ?? 0}
          accent="tertiary"
          sub="awaiting review"
          onClick={() => onNavigate("tasks")}
        />
        <StatCard
          label="Blocked"
          value={byStatus["blocked"] ?? 0}
          accent="error"
          sub="needs attention"
          onClick={() => onNavigate("tasks")}
        />
        <StatCard
          label="Todo"
          value={byStatus["todo"] ?? 0}
          accent="muted"
          sub="queued"
          onClick={() => onNavigate("tasks")}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-8">
        <StatCard
          label="Done"
          value={byStatus["done"] ?? 0}
          accent="secondary"
          sub="completed"
        />
        <StatCard
          label="Active Jobs"
          value={(jobs ?? []).filter((j) => j.enabled).length}
          accent="primary"
          sub={`of ${(jobs ?? []).length} total`}
          onClick={() => onNavigate("jobs")}
        />
        <StatCard
          label="Memories"
          value={memories?.length ?? 0}
          accent="muted"
          onClick={() => onNavigate("memories")}
        />
      </div>

      {/* Recent Tasks */}
      <div className="mb-8">
        <div className="flex justify-between items-center px-1 mb-3">
          <h2 className="font-headline font-extrabold text-sm uppercase tracking-widest text-on-surface">
            Recent Tasks
          </h2>
          <button
            onClick={() => onNavigate("tasks")}
            className="font-label text-[10px] text-primary hover:underline uppercase tracking-widest"
          >
            View all →
          </button>
        </div>
        {tasksLoading ? (
          <div className="space-y-2">
            {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-10 w-full bg-surface-highest" />)}
          </div>
        ) : (
          <div className="border border-surface-highest rounded-sm overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="border-b border-surface-highest hover:bg-transparent">
                  <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">Title</TableHead>
                  <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-32">Status</TableHead>
                  <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">Priority</TableHead>
                  <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-28">Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.map((task) => (
                  <TableRow key={task.id} className="border-b border-surface-highest/50 hover:bg-surface-low">
                    <TableCell className="font-body text-xs text-on-surface truncate max-w-xs">{task.title}</TableCell>
                    <TableCell><StatusBadge status={task.status} /></TableCell>
                    <TableCell><PriorityBadge priority={task.priority} /></TableCell>
                    <TableCell className="font-label text-[10px] text-outline">
                      {new Date(task.updated_at).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Projects summary */}
      {(projects ?? []).length > 0 && (
        <div>
          <h2 className="font-headline font-extrabold text-sm uppercase tracking-widest text-on-surface mb-3 px-1">
            Projects
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {(projects ?? []).slice(0, 6).map((p) => (
              <div
                key={p.id}
                className="bg-surface-high p-4 rounded-sm border border-surface-highest hover:bg-surface-bright transition-colors cursor-pointer"
                onClick={() => onNavigate("projects")}
              >
                <div className="font-label text-xs font-semibold text-on-surface truncate">{p.name}</div>
                {p.description && (
                  <div className="font-body text-[10px] text-outline mt-1 truncate">{p.description}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
