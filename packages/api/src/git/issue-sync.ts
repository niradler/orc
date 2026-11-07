import { resolveGithubAuth } from "@orc/core/github-auth";
import {
  type GithubSyncConfig,
  type GithubSyncState,
  type GithubTaskSync,
  githubIssueStatus,
  githubRepository,
} from "@orc/core/github-sync";
import { ulid } from "@orc/core/ids";
import { createLogger } from "@orc/core/logger";
import type { TaskStatus } from "@orc/core/types";
import { getDb } from "@orc/db/client";
import { projects, tasks } from "@orc/db/schema";
import { updateTaskStatus } from "@orc/task-service";
import { and, eq, or, sql } from "drizzle-orm";
import { z } from "zod";

const logger = createLogger("github:issue-sync");
const IssueSchema = z.object({
  id: z.number().int().positive(),
  number: z.number().int().positive(),
  title: z.string().max(10000),
  body: z.string().nullable(),
  state: z.enum(["open", "closed"]),
  state_reason: z.string().nullable().optional(),
  labels: z.array(z.object({ name: z.string() })),
  updated_at: z.string().datetime(),
  pull_request: z.unknown().optional(),
});
type Issue = z.infer<typeof IssueSchema>;
export interface GithubSyncDeps {
  fetch?: typeof fetch;
  auth?: typeof resolveGithubAuth;
}
const running = new Map<string, Promise<GithubSyncState>>();

function safeError(error: unknown): string {
  return error instanceof SyncError
    ? error.message
    : "GitHub sync failed; check repository access and try again";
}
class SyncError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function syncGithubProject(
  projectId: string,
  deps: GithubSyncDeps = {},
): Promise<GithubSyncState> {
  const pending = running.get(projectId);
  if (pending) return pending;
  const work = syncProject(projectId, deps).finally(() => running.delete(projectId));
  running.set(projectId, work);
  return work;
}

async function syncProject(projectId: string, deps: GithubSyncDeps): Promise<GithubSyncState> {
  const db = getDb();
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project?.github_sync?.enabled || project.status !== "active")
    return {
      synced_at: project?.github_sync_state?.synced_at ?? null,
      error: "GitHub sync is disabled or project is inactive",
    };
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + 45000;
  const repo = githubRepository(project.git_remote_url);
  const config = project.github_sync;
  const fingerprint = JSON.stringify([project.git_remote_url, config, project.status]);
  const ensureActive = async (): Promise<void> => {
    const current = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (
      !current ||
      JSON.stringify([current.git_remote_url, current.github_sync, current.status]) !== fingerprint
    )
      throw new SyncError("Project settings changed during sync; retry with the saved settings");
  };
  const state: GithubSyncState = {
    synced_at: project.github_sync_state?.synced_at ?? null,
    error: null,
  };
  let token: string | undefined;
  const request = async (path: string, method = "GET", body?: unknown): Promise<unknown> => {
    if (Date.now() >= deadline)
      throw new SyncError("GitHub sync timed out; saved progress will be retried next cycle");
    await ensureActive();
    const response = await (deps.fetch ?? fetch)(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(Math.max(1, Math.min(15000, deadline - Date.now()))),
    });
    if (!response.ok)
      throw new SyncError(
        response.status === 401
          ? "GitHub authentication failed; refresh gh auth or the configured token"
          : response.status === 403 || response.status === 429
            ? "GitHub permission denied or rate limited; check issue write access and retry later"
            : "GitHub request failed; check repository access and retry",
        response.status,
      );
    return response.status === 204 ? null : response.json();
  };

  try {
    if (!repo) throw new SyncError("Issue sync requires a github.com repository URL");
    token = (await (deps.auth ?? resolveGithubAuth)()).token;
    if (!token)
      throw new SyncError(
        "GitHub authentication required; sign in with gh or configure a GitHub token",
      );
    const issues = new Map<string, Issue>();
    const since = state.synced_at
      ? `&since=${encodeURIComponent(new Date(Date.parse(state.synced_at) - 60000).toISOString())}`
      : "";
    for (let page = 1; page <= 20; page++) {
      const batch = z
        .array(IssueSchema)
        .parse(
          await request(
            `/issues?state=${since ? "all" : "open"}&sort=updated&direction=desc&per_page=100&page=${page}${since}`,
          ),
        );
      for (const issue of batch) if (!issue.pull_request) issues.set(String(issue.id), issue);
      if (batch.length < 100) break;
      if (page === 20)
        throw new SyncError(
          "Issue sync exceeded 2000 results; narrow the repository backlog before retrying",
        );
    }
    const linked = await db.query.tasks.findMany({ where: eq(tasks.project_id, projectId) });
    for (const task of linked) {
      const sync = task.github_sync;
      if (!sync || sync.repo.toLowerCase() !== repo.toLowerCase() || issues.has(sync.issue_id))
        continue;
      if (task.status !== sync.status || sync.error || sync.pending_status) {
        const issue = IssueSchema.parse(await request(`/issues/${sync.number}`));
        if (String(issue.id) !== sync.issue_id)
          throw new SyncError(
            "Linked GitHub issue identity changed; check the repository and issue link",
          );
        issues.set(sync.issue_id, issue);
      }
    }

    for (const issue of issues.values()) {
      await ensureActive();
      const issueId = String(issue.id);
      const url = `https://github.com/${repo}/issues/${issue.number}`;
      let task = await db.query.tasks.findFirst({
        where: and(
          eq(tasks.project_id, projectId),
          or(
            eq(tasks.github_issue_id, issueId),
            sql`lower(${tasks.github_issue}) = ${url.toLowerCase()}`,
          ),
        ),
      });
      const previous = task?.github_sync;
      if (previous && previous.repo.toLowerCase() !== repo.toLowerCase()) continue;
      let remoteStatus: TaskStatus = "todo";
      let issueError: string | null = null;
      try {
        remoteStatus = githubIssueStatus(issue, config);
      } catch (error) {
        issueError = error instanceof Error ? error.message : "Invalid status labels";
      }
      const sync: GithubTaskSync = previous ?? {
        issue_id: issueId,
        repo,
        number: issue.number,
        status: task?.status ?? remoteStatus,
        remote_updated_at: issue.updated_at,
        synced_at: null,
        error: null,
      };
      if (!task) {
        const [created] = await db
          .insert(tasks)
          .values({
            id: ulid(),
            project_id: projectId,
            title: issue.title,
            body: issue.body,
            status: issueError ? "todo" : remoteStatus,
            github_issue: url,
            github_issue_id: issueId,
            github_sync: sync,
            tags: issue.labels
              .filter(
                (label) =>
                  !Object.values(config.status_labels).some(
                    (name) => name.toLowerCase() === label.name.toLowerCase(),
                  ),
              )
              .map((label) => label.name),
            auto_start: false,
            author: "github",
            created_at: new Date(),
            updated_at: new Date(),
          })
          .returning();
        task = created;
      } else if (!previous) {
        await db
          .update(tasks)
          .set({
            github_issue_id: issueId,
            github_sync: sync,
            auto_start: false,
          })
          .where(eq(tasks.id, task.id));
      }
      if (!task) continue;
      try {
        if (sync.pending_status && sync.pending_status === task.status) {
          if (issue.state === "closed") {
            const closedStatus = issue.state_reason === "not_planned" ? "cancelled" : "done";
            if (closedStatus !== sync.status && closedStatus !== task.status)
              throw new SyncError(
                "GitHub issue was closed during an interrupted write; resolve its status and retry",
              );
          }
          const allowed = new Set([
            config.status_labels[sync.status].toLowerCase(),
            config.status_labels[task.status].toLowerCase(),
          ]);
          const statusNames = Object.values(config.status_labels).map((name) => name.toLowerCase());
          if (
            issue.labels.some(
              (label) =>
                statusNames.includes(label.name.toLowerCase()) &&
                !allowed.has(label.name.toLowerCase()),
            )
          )
            throw new SyncError(
              "Status changed on GitHub during an interrupted write; resolve the status labels and retry",
            );
          issueError = null;
          remoteStatus = sync.status;
        }
        if (issueError) throw new SyncError(issueError);
        const localChanged =
          previous !== undefined && previous !== null && task.status !== sync.status;
        const remoteChanged = remoteStatus !== sync.status;
        if (localChanged && remoteChanged && task.status !== remoteStatus)
          throw new SyncError(
            "Status changed in both ORC and GitHub; choose the same status on both sides to resolve",
          );
        if (localChanged && task.status !== remoteStatus) {
          // Fetch again immediately before writing; unrelated labels are never replaced.
          const fresh = IssueSchema.parse(await request(`/issues/${issue.number}`));
          if (fresh.updated_at !== issue.updated_at && !sync.pending_status)
            throw new SyncError(
              "GitHub issue changed during sync; retry to reconcile the latest status",
            );
          sync.pending_status = task.status;
          await db.update(tasks).set({ github_sync: sync }).where(eq(tasks.id, task.id));
          await writeStatus(fresh, task.status, config, request);
          remoteStatus = task.status;
        } else if (task.status !== remoteStatus) {
          const current = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
          if (!current || current.status !== task.status)
            throw new SyncError("ORC status changed during sync; retry to reconcile it");
          const result = await updateTaskStatus({
            taskId: task.id,
            status: remoteStatus,
            expectedStatus: task.status,
          });
          if (!result.ok) throw new SyncError(result.error ?? "Task status transition failed");
        }
        await ensureActive();
        await db
          .update(tasks)
          .set({
            title: issue.title,
            body: issue.body,
            github_issue: url,
            github_issue_id: issueId,
            ...(!previous ? { auto_start: false } : {}),
            ...(task.title !== issue.title || task.body !== issue.body
              ? { updated_at: new Date() }
              : {}),
            github_sync: {
              ...sync,
              status: remoteStatus,
              number: issue.number,
              pending_status: null,
              remote_updated_at: issue.updated_at,
              synced_at: new Date().toISOString(),
              error: null,
            },
          })
          .where(eq(tasks.id, task.id));
      } catch (error) {
        await ensureActive();
        const message = safeError(error);
        await db
          .update(tasks)
          .set({ github_sync: { ...sync, error: message } })
          .where(eq(tasks.id, task.id));
        state.error = "Some issues could not sync; inspect the affected task sync errors";
      }
    }
    if (!state.error) state.synced_at = startedAt;
  } catch (error) {
    state.error = safeError(error);
  }
  try {
    await ensureActive();
  } catch {
    return { ...state, error: "Project settings changed during sync; retry" };
  }
  await db.update(projects).set({ github_sync_state: state }).where(eq(projects.id, projectId));
  return state;
}

async function writeStatus(
  issue: Issue,
  status: TaskStatus,
  config: GithubSyncConfig,
  request: (path: string, method?: string, body?: unknown) => Promise<unknown>,
): Promise<void> {
  const label = config.status_labels[status];
  try {
    await request(`/labels/${encodeURIComponent(label)}`);
  } catch (error) {
    if (!(error instanceof SyncError) || error.status !== 404) throw error;
    try {
      await request("/labels", "POST", {
        name: label,
        color: "6e7781",
        description: "ORC task status",
      });
    } catch (createError) {
      if (!(createError instanceof SyncError) || createError.status !== 422) throw createError;
      await request(`/labels/${encodeURIComponent(label)}`);
    }
  }
  const mapped = new Set(Object.values(config.status_labels).map((name) => name.toLowerCase()));
  const terminal = status === "done" || status === "cancelled";
  await request(`/issues/${issue.number}`, "PATCH", {
    state: terminal ? "closed" : "open",
    state_reason: terminal ? (status === "done" ? "completed" : "not_planned") : "reopened",
  });
  for (const existing of issue.labels) {
    if (
      mapped.has(existing.name.toLowerCase()) &&
      existing.name.toLowerCase() !== label.toLowerCase()
    )
      await request(
        `/issues/${issue.number}/labels/${encodeURIComponent(existing.name)}`,
        "DELETE",
      );
  }
  const applied = z
    .array(z.object({ name: z.string() }))
    .parse(await request(`/issues/${issue.number}/labels`, "POST", { labels: [label] }));
  const mappedLabels = applied.filter((item) => mapped.has(item.name.toLowerCase()));
  if (mappedLabels.length !== 1 || mappedLabels[0]?.name.toLowerCase() !== label.toLowerCase())
    throw new SyncError(
      "GitHub did not retain the requested status label; check issue write permissions and conflicting labels",
    );
}

export function startGithubIssueSync(intervalMs = 60000): () => Promise<void> {
  let stopped = false;
  let active: Promise<void> | undefined;
  const tick = (): void => {
    if (stopped || active) return;
    active = (async () => {
      const enabled = await getDb().query.projects.findMany({
        where: eq(projects.status, "active"),
      });
      for (const project of enabled) {
        if (stopped) break;
        if (project.github_sync?.enabled) await syncGithubProject(project.id);
      }
    })()
      .catch(() => logger.warn("GitHub issue sync cycle failed; retrying next interval"))
      .finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await active;
  };
}
