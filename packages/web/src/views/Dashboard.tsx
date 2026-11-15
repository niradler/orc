import "./ActivityPreview.css";
import type { UsageReport } from "@orc/core/usage";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Bar, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, type LiveSession, type Project } from "@/api/client";
import { ErrorState } from "@/components/ErrorState";
import { PriorityBadge } from "@/components/PriorityBadge";
import { ResumeActions } from "@/components/ResumeActions";
import { StateBadge } from "@/components/StateBadge";
import { StatusBadge } from "@/components/StatusBadge";
import { type ChartPoint, chartPoints } from "@/components/UsageSettings";
import { Button } from "@/components/ui/button";
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
import { useProjectScope } from "@/hooks/useProjectScope";
import { useProjects } from "@/hooks/useProjects";
import { useLiveSessions } from "@/hooks/useSessions";
import { useTasks } from "@/hooks/useTasks";
import { liveSessionState } from "@/lib/agent-state";
import { compactNumber } from "@/lib/chat-ui-chart";
import { formatTokens, formatWhen } from "@/lib/live-sessions";

interface DashboardProps {
  projectId: string;
}

interface SessionGroup {
  key: string;
  name: string;
  detail: string | null;
  projectId: string | null;
  sessions: LiveSession[];
}

function groupSessions(sessions: LiveSession[], projects: Project[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const session of sessions) {
    const project = projects.find((p) => p.id === session.project_id);
    const key = project ? project.id : `cwd:${session.cwd ?? ""}`;
    const group = groups.get(key) ?? {
      key,
      name: project?.name ?? session.cwd?.split(/[\\/]/).filter(Boolean).pop() ?? "No folder",
      detail: project
        ? (project.git_remote_url
            ?.replace(/\.git$/, "")
            .split(/[:/]/)
            .slice(-2)
            .join("/") ?? null)
        : session.cwd,
      projectId: project?.id ?? null,
      sessions: [],
    };
    group.sessions.push(session);
    groups.set(key, group);
  }
  return [...groups.values()];
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
  const scopeParams = projectId === "all" ? undefined : { project_id: projectId };
  const tasksQuery = useTasks(scopeParams);
  const { data: tasks, isLoading: tasksLoading } = tasksQuery;
  const jobsQuery = useJobs(scopeParams);
  const { data: jobs } = jobsQuery;
  const { data: projects } = useProjects();
  const sessionsQuery = useLiveSessions(false, scopeParams?.project_id);
  const usageQuery = useQuery({
    queryKey: ["usage-report", "30", "day", "", "", projectId],
    queryFn: () =>
      api.settings.usageReport({ days: "30", granularity: "day", ...(scopeParams ?? {}) }),
    staleTime: 30_000,
  });
  const scopedSessions = (sessionsQuery.data ?? []).filter(
    (session) =>
      projectId === "all" ||
      (projectId === "unassigned" ? session.project_id === null : session.project_id === projectId),
  );
  const sessionGroups = groupSessions(
    scopedSessions.filter((session, index) => index < 20 || session.status !== "stopped"),
    projects ?? [],
  ).map((group) => ({ ...group, sessions: group.sessions.slice(0, 5) }));
  const scopedJobs =
    projectId === "unassigned"
      ? (jobs ?? []).filter((job) => job.project_id === null)
      : (jobs ?? []);

  const filteredTasks =
    projectId === "unassigned" ? (tasks ?? []).filter((t) => t.project_id === null) : (tasks ?? []);

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
    <div data-activity-preview data-testid="activity-preview" className="activity-preview">
      <ViewHeader
        title="Activity"
        meta={scopeLabel || "All projects"}
        action={<Button onClick={() => navigate("/tasks")}>View tasks</Button>}
      />

      {[
        { name: "Sessions", query: sessionsQuery },
        { name: "Usage", query: usageQuery },
        { name: "Tasks", query: tasksQuery },
        { name: "Jobs", query: jobsQuery },
      ]
        .filter(({ query }) => query.error)
        .map(({ name, query }) => (
          <ErrorState
            key={name}
            message={`${name}: ${query.error?.message ?? "Could not load activity"}`}
            onRetry={() => query.refetch()}
          />
        ))}

      <ActivityCharts report={usageQuery.data} />

      <ActivitySessions
        groups={sessionGroups}
        loading={sessionsQuery.isLoading}
        onNavigate={navigate}
      />

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
      </div>
    </div>
  );
}

function ActivityCharts({ report }: { report: UsageReport | undefined }) {
  const points = chartPoints(report);
  const total = points.reduce((sum, point) => sum + point.total_tokens, 0);
  return (
    <figure className="activity-chart" data-testid="activity-chart">
      <figcaption>
        <span className="activity-chart-legend">
          <span>
            <i style={{ background: "var(--color-series-1)" }} />
            Tokens
          </span>
          <span>
            <i style={{ background: "var(--color-series-2)" }} />
            Sessions
          </span>
        </span>
        <span className="activity-muted">{compactNumber(total)} tokens in 30 days</span>
      </figcaption>
      <div className="activity-chart-plot">
        {points.length === 0 ? (
          <p className="activity-empty">No usage recorded</p>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={points} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
              <XAxis
                dataKey="label"
                tick={{ fill: "var(--color-muted-foreground)", fontSize: 10 }}
                tickLine={false}
                axisLine={{ stroke: "var(--color-border)" }}
                minTickGap={24}
              />
              <YAxis yAxisId="tokens" hide />
              <YAxis yAxisId="sessions" orientation="right" hide />
              <Tooltip
                cursor={{ fill: "var(--color-border)", opacity: 0.4 }}
                content={({ active, payload }) => {
                  const point = active
                    ? (payload?.[0]?.payload as ChartPoint | undefined)
                    : undefined;
                  if (!point) return null;
                  return (
                    <div className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs tabular-nums shadow-sm">
                      <p className="font-medium">{point.label}</p>
                      <p>{compactNumber(point.total_tokens)} tokens</p>
                      <p>{point.sessions} sessions</p>
                    </div>
                  );
                }}
              />
              <Bar
                yAxisId="tokens"
                dataKey="total_tokens"
                fill="var(--color-series-1)"
                radius={[2, 2, 0, 0]}
                isAnimationActive={false}
              />
              <Line
                yAxisId="sessions"
                dataKey="sessions"
                type="monotone"
                stroke="var(--color-series-2)"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </figure>
  );
}

function ActivitySessions({
  groups,
  loading,
  onNavigate,
}: {
  groups: SessionGroup[];
  loading: boolean;
  onNavigate: (path: string) => void;
}) {
  return (
    <section className="activity-section" aria-label="Recent sessions">
      <div className="activity-section-heading">
        <h2>Sessions</h2>
        <button
          type="button"
          className="activity-text-action"
          onClick={() => onNavigate("/chat?sessionList=show")}
        >
          View all
        </button>
      </div>
      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((key) => (
            <Skeleton key={key} className="h-12 w-full" />
          ))}
        </div>
      ) : groups.length === 0 ? (
        <p className="activity-empty">No sessions yet</p>
      ) : (
        <div className="activity-session-groups">
          {groups.map((group) => {
            const live = group.sessions.filter((session) => session.status !== "stopped").length;
            const tokens = group.sessions.reduce(
              (sum, session) => sum + (session.tokens_used ?? 0),
              0,
            );
            return (
              <div
                key={group.key}
                className="activity-session-group"
                data-testid="activity-session-group"
              >
                <div className="activity-session-group-heading">
                  <span className="min-w-0 truncate">
                    {group.projectId ? (
                      <button
                        type="button"
                        className="activity-group-name"
                        onClick={() => onNavigate(`/projects/${group.projectId}`)}
                      >
                        {group.name}
                      </button>
                    ) : (
                      <span className="activity-group-name">{group.name}</span>
                    )}
                    {group.detail && (
                      <span className="activity-group-detail" title={group.detail}>
                        {group.detail}
                      </span>
                    )}
                  </span>
                  <span className="activity-muted shrink-0 tabular-nums">
                    {live > 0 ? `${live} live · ` : ""}
                    {compactNumber(tokens)} tokens
                  </span>
                </div>
                {group.sessions.map((session) => (
                  <div
                    key={session.id}
                    className="activity-session"
                    data-stopped={session.status === "stopped" || undefined}
                  >
                    <button
                      type="button"
                      className="activity-session-main"
                      data-testid="activity-session-link"
                      data-session-id={session.id}
                      onClick={() =>
                        onNavigate(`/chat?sessionLive=${encodeURIComponent(session.id)}`)
                      }
                    >
                      <StateBadge state={liveSessionState(session)} compact />
                      <span className="activity-session-title">
                        {session.name ?? session.summary ?? session.agent}
                      </span>
                      <span className="activity-session-meta">
                        <span>{session.agent}</span>
                        <span className="tabular-nums">{formatTokens(session)}</span>
                        <span>{formatWhen(session.last_activity_at)}</span>
                        {session.task && (
                          <span className="activity-session-task" title={session.task.title}>
                            {session.task.title}
                          </span>
                        )}
                      </span>
                    </button>
                    <ResumeActions session={session} />
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
