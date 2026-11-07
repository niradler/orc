import type { Database } from "bun:sqlite";
import { loadConfig } from "@orc/core/config";
import type { NotificationInput, OrcNotification } from "@orc/core/notifications";
import { NotificationStore } from "./notifications.js";

export function publishNotification(
  db: Database,
  event: Omit<NotificationInput, "created_at" | "expires_at"> & {
    created_at?: number;
    expires_at?: number;
  },
): OrcNotification | null {
  const createdAt = event.created_at ?? Date.now();
  return new NotificationStore(db).publish({
    ...event,
    title: event.title.trim().slice(0, 200) || "Notification",
    body: event.body?.slice(0, 500),
    created_at: createdAt,
    expires_at:
      event.expires_at ??
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
        notify_on: string;
        project_id: string | null;
      },
      [string]
    >(`SELECT r.id,r.job_id,r.status,r.ended_at,j.name,j.notify_on,j.project_id
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
    title: `${run.name} ${success ? "finished" : "failed"}`,
    body: success ? "Job completed successfully." : "Open the job to inspect its run and logs.",
    level: success ? "done" : "needs-you",
    project_id: run.project_id,
    path: `/jobs/${encodeURIComponent(run.job_id)}?run=${encodeURIComponent(run.id)}&project=all`,
    created_at: run.ended_at === null ? Date.now() : run.ended_at * 1000,
  });
}
