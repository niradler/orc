import { useNavigate } from "react-router-dom";
import { ErrorState } from "@/components/ErrorState";
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
import { useBreakpoint } from "@/hooks/useMediaQuery";
import { useMemories } from "@/hooks/useMemories";
import { useProjectScope } from "@/hooks/useProjectScope";
import { useProjects } from "@/hooks/useProjects";
import { useLoggedSessions } from "@/hooks/useSessions";
import { useTasks } from "@/hooks/useTasks";

interface DashboardProps {
  projectId: string;
}

function displayedCount(query: { isLoading: boolean; error: unknown }, value: number) {
  return query.isLoading ? "…" : query.error ? "—" : value;
}

export default function Dashboard({ projectId: savedProjectId }: DashboardProps) {
  const routeNavigate = useNavigate();
  const projectId = useProjectScope(savedProjectId);
  const desktop = useBreakpoint("sm");
  const navigate = (path: string) => {
    const target = new URL(path, window.location.origin);
    target.searchParams.set("project", projectId);
    routeNavigate({ pathname: target.pathname, search: target.search, hash: target.hash });
  };
  const scopeParams =
    projectId === "all"
      ? undefined
      : projectId === "unassigned"
        ? undefined
        : { project_id: projectId };
  const tasksQuery = useTasks(scopeParams);
  const { data: tasks, isLoading: tasksLoading } = tasksQuery;
  const jobsQuery = useJobs(scopeParams);
  const { data: jobs } = jobsQuery;
  const memoriesQuery = useMemories(scopeParams);
  const { data: memories } = memoriesQuery;
  const { data: projects } = useProjects();
  const sessionsQuery = useLoggedSessions({
    ...(projectId === "all" ? {} : { project_id: projectId }),
    limit: 5,
    offset: 0,
  });
  const sessions = sessionsQuery.data?.sessions ?? [];
  const scopedJobs =
    projectId === "unassigned"
      ? (jobs ?? []).filter((job) => job.project_id === null)
      : (jobs ?? []);
  const scopedMemories =
    projectId === "unassigned"
      ? (memories ?? []).filter((memory) => memory.project_id === null)
      : (memories ?? []);

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

  const activeJobs = scopedJobs.filter((j) => j.enabled);

  const scopeLabel =
    projectId === "all"
      ? "All Projects"
      : projectId === "unassigned"
        ? "Unassigned"
        : (projects?.find((p) => p.id === projectId)?.name ?? "");

  return (
    <div>
      <ViewHeader title="Activity" meta={scopeLabel !== "All Projects" ? scopeLabel : undefined} />

      {[tasksQuery, jobsQuery, memoriesQuery, sessionsQuery].some((query) => query.isLoading) && (
        <p role="status" className="mb-4 text-sm text-outline">
          Loading activity…
        </p>
      )}
      {[
        { name: "Tasks", query: tasksQuery },
        { name: "Jobs", query: jobsQuery },
        { name: "Memories", query: memoriesQuery },
        { name: "Sessions", query: sessionsQuery },
      ]
        .filter(({ query }) => query.error)
        .map(({ name, query }) => (
          <ErrorState
            key={name}
            message={`${name}: ${query.error?.message ?? "Could not load activity"}`}
            onRetry={() => query.refetch()}
          />
        ))}
      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
        <StatCard
          label="Doing"
          value={displayedCount(tasksQuery, byStatus.doing ?? 0)}
          accent="primary"
          sub="in progress"
          onClick={() => navigate("/tasks?view=table&status=doing")}
        />
        <StatCard
          label="Review"
          value={displayedCount(tasksQuery, byStatus.review ?? 0)}
          accent="tertiary"
          sub="awaiting review"
          onClick={() => navigate("/tasks?view=table&status=review")}
        />
        <StatCard
          label="Blocked"
          value={displayedCount(tasksQuery, byStatus.blocked ?? 0)}
          accent="error"
          sub="needs attention"
          onClick={() => navigate("/tasks?view=table&status=blocked")}
        />
        {/* queued counts as pending, not in progress: a queued task is waiting for
            a worker slot and no agent has started on it. The kanban board maps it
            into Todo for the same reason (see board-utils.toVisibleStatus). */}
        <StatCard
          label="Todo"
          value={displayedCount(tasksQuery, (byStatus.todo ?? 0) + (byStatus.queued ?? 0))}
          accent="muted"
          sub="pending"
          onClick={() => navigate("/tasks?view=board")}
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
        <StatCard
          label="Done"
          value={displayedCount(tasksQuery, byStatus.done ?? 0)}
          accent="secondary"
          sub="completed"
          onClick={() => navigate("/tasks?view=table&status=done")}
        />
        <StatCard
          label="Active jobs"
          value={displayedCount(jobsQuery, activeJobs.length)}
          accent="primary"
          sub={`of ${scopedJobs.length} total`}
          onClick={() => navigate("/jobs")}
        />
        <StatCard
          label="Memories"
          value={displayedCount(memoriesQuery, scopedMemories.length)}
          accent="muted"
          onClick={() => navigate("/knowledge/memories")}
        />
        <StatCard
          label="Projects"
          value={(projects ?? []).filter((p) => p.status === "active").length}
          accent="muted"
          sub="active across workspace"
          onClick={() => navigate("/projects")}
        />
      </div>

      {/* Recent tasks */}
      <div className="mb-8">
        <div className="flex justify-between items-center px-1 mb-3">
          <h2 className="font-headline font-semibold text-base text-on-surface">Recent tasks</h2>
          <button
            type="button"
            onClick={() => navigate("/tasks")}
            className="font-label text-xs text-primary hover:underline font-medium"
          >
            View all
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
        ) : !desktop ? (
          <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
            {recent.map((task) => (
              <article key={task.id} className="p-4 space-y-3">
                <button
                  type="button"
                  className="min-h-11 text-sm text-left font-medium text-on-surface break-words hover:text-primary"
                  onClick={() => navigate(`/tasks/${task.id}`)}
                >
                  {task.title}
                </button>
                <div className="flex flex-wrap items-center gap-3">
                  <StatusBadge status={task.status} />
                  <PriorityBadge priority={task.priority} />
                  <span className="text-xs text-outline">
                    Updated {new Date(task.updated_at).toLocaleDateString()}
                  </span>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="min-w-0 border border-surface-highest rounded-xl overflow-hidden bg-surface">
            <Table>
              <TableHeader>
                <TableRow className="border-b border-surface-highest hover:bg-transparent">
                  <TableHead className="font-label text-xs font-medium text-outline">
                    Title
                  </TableHead>
                  <TableHead className="font-label text-xs font-medium text-outline w-32">
                    Status
                  </TableHead>
                  <TableHead className="font-label text-xs font-medium text-outline w-24">
                    Priority
                  </TableHead>
                  <TableHead className="font-label text-xs font-medium text-outline w-28">
                    Updated
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.map((task) => (
                  <TableRow
                    key={task.id}
                    className="border-b border-surface-highest/50 hover:bg-surface-low cursor-pointer"
                    onClick={() => navigate(`/tasks/${task.id}`)}
                  >
                    <TableCell className="font-body text-xs text-on-surface truncate max-w-xs">
                      <button
                        type="button"
                        className="text-left font-medium hover:text-primary"
                        onClick={(event) => {
                          event.stopPropagation();
                          navigate(`/tasks/${task.id}`);
                        }}
                      >
                        {task.title}
                      </button>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={task.status} />
                    </TableCell>
                    <TableCell>
                      <PriorityBadge priority={task.priority} />
                    </TableCell>
                    <TableCell className="font-label text-xs text-outline">
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
        {/* Active jobs */}
        {activeJobs.length > 0 && (
          <div>
            <div className="flex justify-between items-center px-1 mb-3">
              <h2 className="font-headline font-semibold text-base text-on-surface">Active jobs</h2>
              <button
                type="button"
                onClick={() => navigate("/jobs")}
                className="font-label text-xs text-primary hover:underline font-medium"
              >
                View all
              </button>
            </div>
            <div className="space-y-2">
              {activeJobs.slice(0, 5).map((job) => (
                <button
                  key={job.id}
                  type="button"
                  className="w-full text-left bg-surface p-3 rounded-lg border border-surface-highest hover:bg-surface-low transition-colors cursor-pointer"
                  onClick={() => navigate(`/jobs/${job.id}`)}
                >
                  <div className="flex items-center justify-between">
                    <div className="font-label text-xs font-semibold text-on-surface">
                      {job.name}
                    </div>
                    <span className="font-label text-xs text-outline">{job.trigger_type}</span>
                  </div>
                  {job.last_run_at && (
                    <div className="font-body text-xs text-outline mt-1">
                      Last run: {new Date(job.last_run_at).toLocaleString()}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Recent sessions */}
        {sessions.length > 0 && (
          <div>
            <div className="flex justify-between items-center px-1 mb-3">
              <h2 className="font-headline font-semibold text-base text-on-surface">
                Recent sessions
              </h2>
              <button
                type="button"
                onClick={() => navigate("/sessions")}
                className="font-label text-xs text-primary hover:underline font-medium"
              >
                View all
              </button>
            </div>
            <div className="space-y-2">
              {sessions.slice(0, 5).map((session) => (
                <button
                  key={session.id}
                  type="button"
                  className="w-full text-left bg-surface p-3 rounded-lg border border-surface-highest hover:bg-surface-low transition-colors cursor-pointer"
                  onClick={() => navigate(`/sessions/${session.id}?tab=orc`)}
                >
                  <div className="flex items-center justify-between">
                    <div className="font-label text-xs font-semibold text-on-surface">
                      {session.agent ?? "unknown"}
                    </div>
                    <span className="font-label text-xs text-outline">
                      {new Date(session.created_at).toLocaleString()}
                    </span>
                  </div>
                  {session.summary && (
                    <div className="font-body text-xs text-outline mt-1 truncate">
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
            <h2 className="font-headline font-semibold text-base text-on-surface">Projects</h2>
            <button
              type="button"
              onClick={() => navigate("/projects")}
              className="font-label text-xs text-primary hover:underline font-medium"
            >
              View all
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
                  className="text-left bg-surface p-4 rounded-lg border border-surface-highest hover:bg-surface-low transition-colors cursor-pointer"
                  onClick={() => navigate(`/projects/${p.id}`)}
                >
                  <div className="font-label text-xs font-semibold text-on-surface truncate">
                    {p.name}
                  </div>
                  {p.description && (
                    <div className="font-body text-xs text-outline mt-1 truncate">
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
