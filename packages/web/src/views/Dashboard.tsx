import { useNavigate } from "react-router-dom";
import { PriorityBadge } from "@/components/PriorityBadge";
import { StatCard } from "@/components/StatCard";
import { StatusBadge } from "@/components/StatusBadge";
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
import { useJobs } from "@/hooks/useJobs";
import { useMemories } from "@/hooks/useMemories";
import { useProjectScope } from "@/hooks/useProjectScope";
import { useProjects } from "@/hooks/useProjects";
import { useSessions } from "@/hooks/useSessions";
import { useTasks } from "@/hooks/useTasks";

interface DashboardProps {
  projectId: string;
}

export default function Dashboard({ projectId: savedProjectId }: DashboardProps) {
  const navigate = useNavigate();
  const projectId = useProjectScope(savedProjectId);
  const scopeParams =
    projectId === "all"
      ? undefined
      : projectId === "unassigned"
        ? undefined
        : { project_id: projectId };
  const { data: tasks, isLoading: tasksLoading } = useTasks(scopeParams);
  const { data: jobs } = useJobs(scopeParams);
  const { data: memories } = useMemories(scopeParams);
  const { data: projects } = useProjects();
  const { data: sessions } = useSessions({ limit: 5 });

  const filteredTasks =
    projectId === "unassigned" ? (tasks ?? []).filter((t) => t.project_id === null) : (tasks ?? []);

  const byStatus = filteredTasks.reduce(
    (acc, t) => {
      acc[t.status] = (acc[t.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const recent = [...filteredTasks]
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, 8);

  const activeJobs = (jobs ?? []).filter((j) => j.enabled);

  const scopeLabel =
    projectId === "all"
      ? "All Projects"
      : projectId === "unassigned"
        ? "Unassigned"
        : (projects?.find((p) => p.id === projectId)?.name ?? "");

  return (
    <div>
      <ViewHeader title="Dashboard" meta={scopeLabel !== "All Projects" ? scopeLabel : undefined} />

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
        <StatCard
          label="Doing"
          value={byStatus.doing ?? 0}
          accent="primary"
          sub="in progress"
          onClick={() => navigate("/tasks")}
        />
        <StatCard
          label="Review"
          value={byStatus.review ?? 0}
          accent="tertiary"
          sub="awaiting review"
          onClick={() => navigate("/tasks")}
        />
        <StatCard
          label="Blocked"
          value={byStatus.blocked ?? 0}
          accent="error"
          sub="needs attention"
          onClick={() => navigate("/tasks")}
        />
        <StatCard
          label="Todo"
          value={(byStatus.todo ?? 0) + (byStatus.queued ?? 0)}
          accent="muted"
          sub="pending"
          onClick={() => navigate("/tasks")}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-8">
        <StatCard label="Done" value={byStatus.done ?? 0} accent="secondary" sub="completed" />
        <StatCard
          label="Active Jobs"
          value={activeJobs.length}
          accent="primary"
          sub={`of ${(jobs ?? []).length} total`}
          onClick={() => navigate("/jobs")}
        />
        <StatCard
          label="Memories"
          value={memories?.length ?? 0}
          accent="muted"
          onClick={() => navigate("/memories")}
        />
        <StatCard
          label="Projects"
          value={(projects ?? []).filter((p) => p.status === "active").length}
          accent="muted"
          sub="active"
          onClick={() => navigate("/projects")}
        />
      </div>

      {/* Recent Tasks */}
      <div className="mb-8">
        <div className="flex justify-between items-center px-1 mb-3">
          <h2 className="font-headline font-extrabold text-sm uppercase tracking-widest text-on-surface">
            Recent Tasks
          </h2>
          <button
            type="button"
            onClick={() => navigate("/tasks")}
            className="font-label text-[10px] text-primary hover:underline uppercase tracking-widest"
          >
            View all →
          </button>
        </div>
        {tasksLoading ? (
          <div className="space-y-2">
            {[...Array(4)].map((_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
              <Skeleton key={i} className="h-10 w-full bg-surface-highest" />
            ))}
          </div>
        ) : recent.length === 0 ? (
          <div className="text-center py-8 font-body text-xs text-outline">No tasks</div>
        ) : (
          <div className="border border-surface-highest rounded-sm overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="border-b border-surface-highest hover:bg-transparent">
                  <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">
                    Title
                  </TableHead>
                  <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-32">
                    Status
                  </TableHead>
                  <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">
                    Priority
                  </TableHead>
                  <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-28">
                    Updated
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.map((task) => (
                  <TableRow
                    key={task.id}
                    className="border-b border-surface-highest/50 hover:bg-surface-low cursor-pointer"
                    onClick={() => navigate("/tasks")}
                  >
                    <TableCell className="font-body text-xs text-on-surface truncate max-w-xs">
                      {task.title}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={task.status} />
                    </TableCell>
                    <TableCell>
                      <PriorityBadge priority={task.priority} />
                    </TableCell>
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

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Active Jobs */}
        {activeJobs.length > 0 && (
          <div>
            <div className="flex justify-between items-center px-1 mb-3">
              <h2 className="font-headline font-extrabold text-sm uppercase tracking-widest text-on-surface">
                Active Jobs
              </h2>
              <button
                type="button"
                onClick={() => navigate("/jobs")}
                className="font-label text-[10px] text-primary hover:underline uppercase tracking-widest"
              >
                View all →
              </button>
            </div>
            <div className="space-y-2">
              {activeJobs.slice(0, 5).map((job) => (
                <button
                  key={job.id}
                  type="button"
                  className="w-full text-left bg-surface p-3 rounded-sm border border-surface-highest hover:bg-surface-low transition-colors cursor-pointer"
                  onClick={() => navigate("/jobs")}
                >
                  <div className="flex items-center justify-between">
                    <div className="font-label text-xs font-semibold text-on-surface">
                      {job.name}
                    </div>
                    <span className="font-label text-[10px] text-outline">{job.trigger_type}</span>
                  </div>
                  {job.last_run_at && (
                    <div className="font-body text-[10px] text-outline mt-1">
                      Last run: {new Date(job.last_run_at).toLocaleString()}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Recent Sessions */}
        {(sessions ?? []).length > 0 && (
          <div>
            <div className="flex justify-between items-center px-1 mb-3">
              <h2 className="font-headline font-extrabold text-sm uppercase tracking-widest text-on-surface">
                Recent Sessions
              </h2>
              <button
                type="button"
                onClick={() => navigate("/sessions")}
                className="font-label text-[10px] text-primary hover:underline uppercase tracking-widest"
              >
                View all →
              </button>
            </div>
            <div className="space-y-2">
              {(sessions ?? []).slice(0, 5).map((session) => (
                <button
                  key={session.id}
                  type="button"
                  className="w-full text-left bg-surface p-3 rounded-sm border border-surface-highest hover:bg-surface-low transition-colors cursor-pointer"
                  onClick={() => navigate("/sessions")}
                >
                  <div className="flex items-center justify-between">
                    <div className="font-label text-xs font-semibold text-on-surface">
                      {session.agent ?? "unknown"}
                    </div>
                    <span className="font-label text-[10px] text-outline">
                      {new Date(session.created_at).toLocaleString()}
                    </span>
                  </div>
                  {session.summary && (
                    <div className="font-body text-[10px] text-outline mt-1 truncate">
                      {session.summary}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Projects Grid */}
      {projectId === "all" && (projects ?? []).length > 0 && (
        <div className="mt-8">
          <div className="flex justify-between items-center px-1 mb-3">
            <h2 className="font-headline font-extrabold text-sm uppercase tracking-widest text-on-surface">
              Projects
            </h2>
            <button
              type="button"
              onClick={() => navigate("/projects")}
              className="font-label text-[10px] text-primary hover:underline uppercase tracking-widest"
            >
              View all →
            </button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {(projects ?? [])
              .filter((p) => p.status === "active")
              .slice(0, 6)
              .map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="text-left bg-surface p-4 rounded-sm border border-surface-highest hover:bg-surface-low transition-colors cursor-pointer"
                  onClick={() => navigate("/projects")}
                >
                  <div className="font-label text-xs font-semibold text-on-surface truncate">
                    {p.name}
                  </div>
                  {p.description && (
                    <div className="font-body text-[10px] text-outline mt-1 truncate">
                      {p.description}
                    </div>
                  )}
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
