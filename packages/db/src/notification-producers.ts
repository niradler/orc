import type { Database } from "bun:sqlite";
import { loadConfig } from "@orc/core/config";
import type { NotificationInput, OrcNotification } from "@orc/core/notifications";
import { NotificationStore } from "./notifications.js";

/**
 * A notification names where it came from: the owning project, or the source
 * folder when no project claims it. The label is cosmetic, never user content.
 */
export function notificationProjectLabel(
  db: Database,
  projectId: string | null | undefined,
  cwd?: string | null,
): string | null {
  if (projectId) {
    // Some embedders open only the request and notification tables.
    const hasProjects = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='projects'",
      )
      .get();
    if (hasProjects) {
      const name = db
        .query<{ name: string }, [string]>("SELECT name FROM projects WHERE id=?")
        .get(projectId)?.name;
      if (name?.trim()) return name.trim().slice(0, 80);
    }
  }
  const folder = cwd?.trim().replace(/[\\/]+$/, "");
  const base = folder?.slice(Math.max(folder.lastIndexOf("/"), folder.lastIndexOf("\\")) + 1);
  return base && base !== "." && base !== ".." ? base.slice(0, 80) : null;
}

type NotificationEvent = Omit<NotificationInput, "created_at" | "expires_at"> & {
  created_at?: number;
  expires_at?: number;
  /** The source folder, used for the label when no project owns it. */
  cwd?: string | null;
};

export function publishNotification(
  db: Database,
  event: NotificationEvent,
): OrcNotification | null {
  const { cwd, ...input } = event;
  const createdAt = input.created_at ?? Date.now();
  const label = notificationProjectLabel(db, input.project_id, cwd);
  return new NotificationStore(db).publish({
    ...input,
    title:
      (label ? `${label} · ${input.title}` : input.title).trim().slice(0, 200) || "Notification",
    body: input.body?.slice(0, 500),
    created_at: createdAt,
    expires_at:
      input.expires_at ??
      createdAt + (loadConfig().preferences.notification_retention_days ?? 30) * 86400000,
  });
}

export function publishJobNotification(db: Database, runId: string): void {
  const run = db
    .query<
      {
        id: string;
        job_id: string;
        name: string;
        status: string;
        ended_at: number | null;
        started_at: number | null;
        exit_code: number | null;
        notify_on: string;
        project_id: string | null;
        working_dir: string | null;
      },
      [string]
    >(`SELECT r.id,r.job_id,r.status,r.ended_at,r.started_at,r.exit_code,j.name,j.notify_on,j.project_id,j.working_dir
    FROM job_runs r JOIN jobs j ON j.id=r.job_id WHERE r.id=?`)
    .get(runId);
  if (!run || !["success", "failed", "timeout"].includes(run.status) || run.notify_on === "never")
    return;
  const success = run.status === "success";
  if (success && run.notify_on !== "always") return;
  publishNotification(db, {
    type: success ? "job.finished" : "job.failed",
    source_key: `job:${run.id}`,
    source_id: run.id,
    title: `${run.name} ${success ? "finished" : run.status === "timeout" ? "timed out" : "failed"}`,
    body: jobRunDetail(run),
    level: success ? "done" : "needs-you",
    project_id: run.project_id,
    cwd: run.working_dir,
    path: `/jobs/${encodeURIComponent(run.job_id)}?run=${encodeURIComponent(run.id)}&project=all`,
    created_at: run.ended_at === null ? Date.now() : run.ended_at * 1000,
  });
}

function jobRunDetail(run: {
  status: string;
  started_at: number | null;
  ended_at: number | null;
  exit_code: number | null;
}): string {
  const elapsed =
    run.started_at === null || run.ended_at === null
      ? null
      : Math.max(0, Math.round(run.ended_at - run.started_at));
  const timing =
    elapsed === null ? "" : run.status === "success" ? `in ${elapsed}s` : `after ${elapsed}s`;
  const exit = run.exit_code === null ? "" : `exit ${run.exit_code}`;
  const detail = [timing, exit].filter(Boolean).join(", ");
  if (run.status === "success") return detail ? `Finished ${detail}.` : "Finished.";
  const verb = run.status === "timeout" ? "Timed out" : "Failed";
  return detail ? `${verb} ${detail}. Open the run for logs.` : `${verb}. Open the run for logs.`;
}
