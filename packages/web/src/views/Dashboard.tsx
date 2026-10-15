import "./ActivityPreview.css";
import { useNavigate } from "react-router-dom";
import { ErrorState } from "@/components/ErrorState";
import { PriorityBadge } from "@/components/PriorityBadge";
import { ResumeActions } from "@/components/ResumeActions";
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
import { useJobs } from "@/hooks/useJobs";
import { useBreakpoint } from "@/hooks/useMediaQuery";
import { useMemories } from "@/hooks/useMemories";
import { useProjectScope } from "@/hooks/useProjectScope";
import { useProjects } from "@/hooks/useProjects";
import { useLiveSessions } from "@/hooks/useSessions";
import { useTasks } from "@/hooks/useTasks";
import { formatWhen, STATUS } from "@/lib/live-sessions";

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
  const sessionsQuery = useLiveSessions(true);
  const sessions = (sessionsQuery.data ?? []).filter(
    (session) =>
      projectId === "all" ||
      (projectId === "unassigned" ? session.project_id === null : session.project_id === projectId),
  );
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

  const taskMetrics = [
    {
      label: "Doing",
      value: displayedCount(tasksQuery, byStatus.doing ?? 0),
      sub: "in progress",
      path: "/tasks?view=table&status=doing",
    },
    {
      label: "Review",
      value: displayedCount(tasksQuery, byStatus.review ?? 0),
      sub: "awaiting review",
      path: "/tasks?view=table&status=review",
    },
    {
      label: "Blocked",
      value: displayedCount(tasksQuery, byStatus.blocked ?? 0),
      sub: "needs attention",
      path: "/tasks?view=table&status=blocked",
    },
    {
      label: "Todo",
      value: displayedCount(tasksQuery, (byStatus.todo ?? 0) + (byStatus.queued ?? 0)),
      sub: "pending",
      path: "/tasks?view=board",
    },
    {
      label: "Done",
      value: displayedCount(tasksQuery, byStatus.done ?? 0),
      sub: "completed",
      path: "/tasks?view=table&status=done",
    },
  ];
  const resourceMetrics = [
    {
      label: "Active jobs",
      value: displayedCount(jobsQuery, activeJobs.length),
      sub: `of ${scopedJobs.length} total`,
      path: "/jobs",
    },
    {
      label: "Memories",
      value: displayedCount(memoriesQuery, scopedMemories.length),
      sub: "in this scope",
      path: "/knowledge/memories",
    },
    {
      label: "Projects",
      value: (projects ?? []).filter((project) => project.status === "active").length,
      sub: "active across workspace",
      path: "/projects",
    },
  ];

  return (
    <div data-activity-preview data-testid="activity-preview" className="activity-preview">
      <div className="activity-heading">
        <div>
          <h1 data-testid="view-title">Activity</h1>
          <p data-testid="view-meta">{scopeLabel || "All projects"}</p>
        </div>
        <button type="button" className="activity-primary" onClick={() => navigate("/tasks")}>
          View tasks
        </button>
      </div>

      {[tasksQuery, jobsQuery, memoriesQuery, sessionsQuery].some((query) => query.isLoading) && (
        <p role="status" className="activity-muted mb-4">
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

      <section className="activity-metrics" aria-label="Task summary">
        {taskMetrics.map((metric) => (
          <button
            key={metric.label}
            type="button"
            data-testid="stat-card"
            data-stat-label={metric.label}
            className="activity-metric"
            onClick={() => navigate(metric.path)}
          >
            <span className="activity-metric-label">{metric.label}</span>
            <span data-testid="stat-card-value" className="activity-metric-value">
              {metric.value}
            </span>
            <span className="activity-metric-sub">{metric.sub}</span>
          </button>
        ))}
      </section>
      <section className="activity-resources" aria-label="Workspace summary">
        {resourceMetrics.map((metric) => (
          <button
            key={metric.label}
            type="button"
            data-testid="stat-card"
            data-stat-label={metric.label}
            onClick={() => navigate(metric.path)}
          >
            <span>{metric.label}</span>
            <span data-testid="stat-card-value" className="activity-resource-value">
              {metric.value}
            </span>
            <span className="activity-resource-sub">{metric.sub}</span>
          </button>
        ))}
      </section>

      <section className="activity-section">
        <div className="activity-section-heading">
          <h2>Recent tasks</h2>
          <button type="button" className="activity-text-action" onClick={() => navigate("/tasks")}>
            View all
          </button>
        </div>
        {tasksLoading ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((key) => (
              <Skeleton key={key} className="h-10 w-full" />
            ))}
          </div>
        ) : recent.length === 0 ? (
          <p className="activity-empty">No tasks</p>
        ) : !desktop ? (
          <div className="activity-task-list">
            {recent.map((task) => (
              <article key={task.id} className="activity-task-mobile">
                <button
                  type="button"
                  className="activity-task-title"
                  onClick={() => navigate(`/tasks/${task.id}`)}
                >
                  {task.title}
                </button>
                <div className="activity-task-meta">
                  <span className="activity-status" data-status={task.status}>
                    <StatusBadge status={task.status} />
                  </span>
                  <span className="activity-priority">
                    <PriorityBadge priority={task.priority} />
                  </span>
                  <span>{new Date(task.updated_at).toLocaleDateString()}</span>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <Table className="activity-task-table">
            <TableHeader>
              <TableRow>
                <TableHead>Task</TableHead>
                <TableHead className="w-36">Status</TableHead>
                <TableHead className="w-28">Priority</TableHead>
                <TableHead className="w-28">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recent.map((task) => (
                <TableRow key={task.id} onClick={() => navigate(`/tasks/${task.id}`)}>
                  <TableCell>
                    <button
                      type="button"
                      className="activity-task-title"
                      onClick={(event) => {
                        event.stopPropagation();
                        navigate(`/tasks/${task.id}`);
                      }}
                    >
                      {task.title}
                    </button>
                  </TableCell>
                  <TableCell>
                    <span className="activity-status" data-status={task.status}>
                      <StatusBadge status={task.status} />
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="activity-priority">
                      <PriorityBadge priority={task.priority} />
                    </span>
                  </TableCell>
                  <TableCell className="activity-muted">
                    {new Date(task.updated_at).toLocaleDateString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <div className="activity-secondary">
        {activeJobs.length > 0 && (
          <section className="activity-section">
            <div className="activity-section-heading">
              <h2>Active jobs</h2>
              <button
                type="button"
                className="activity-text-action"
                onClick={() => navigate("/jobs")}
              >
                View all
              </button>
            </div>
            <div className="activity-row-list">
              {activeJobs.slice(0, 5).map((job) => (
                <button
                  key={job.id}
                  type="button"
                  className="activity-row"
                  onClick={() => navigate(`/jobs/${job.id}`)}
                >
                  <span className="activity-row-heading">
                    <span>{job.name}</span>
                    <span className="activity-muted">{job.trigger_type}</span>
                  </span>
                  {job.last_run_at && (
                    <span className="activity-row-description">
                      Last run {new Date(job.last_run_at).toLocaleString()}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </section>
        )}
        {sessions.length > 0 && (
          <section className="activity-section">
            <div className="activity-section-heading">
              <h2>Agent sessions</h2>
              <button
                type="button"
                className="activity-text-action"
                onClick={() => navigate("/sessions")}
              >
                View all
              </button>
            </div>
            <div className="activity-row-list">
              {sessions.slice(0, 5).map((session) => (
                <div key={session.id} className="activity-row">
                  <button
                    type="button"
                    className="w-full text-left"
                    data-testid="activity-session-link"
                    data-session-id={session.id}
                    onClick={() => navigate(`/sessions?session=${encodeURIComponent(session.id)}`)}
                  >
                    <span className="activity-row-heading">
                      <span>{session.name ?? session.agent}</span>
                      <span className="activity-muted">{formatWhen(session.last_activity_at)}</span>
                    </span>
                    <span className="activity-row-description inline-flex items-center gap-2">
                      <span className={`size-1.5 rounded-full ${STATUS[session.status].dot}`} />
                      {session.agent} · {STATUS[session.status].label}
                      {session.task ? ` · ${session.task.title}` : ""}
                    </span>
                  </button>
                  <ResumeActions session={session} />
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      {projectId === "all" && (projects ?? []).length > 0 && (
        <section className="activity-section">
          <div className="activity-section-heading">
            <h2>Projects</h2>
            <button
              type="button"
              className="activity-text-action"
              onClick={() => navigate("/projects")}
            >
              View all
            </button>
          </div>
          <div className="activity-projects">
            {(projects ?? [])
              .filter((project) => project.status === "active")
              .slice(0, 6)
              .map((project) => (
                <button
                  key={project.id}
                  type="button"
                  className="activity-row"
                  onClick={() => navigate(`/projects/${project.id}`)}
                >
                  <span className="activity-row-heading">{project.name}</span>
                  {project.description && (
                    <span className="activity-row-description">{project.description}</span>
                  )}
                </button>
              ))}
          </div>
        </section>
      )}
    </div>
  );
}
