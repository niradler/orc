import { z } from "zod";
import { ValidationError } from "./errors.js";
import { type TaskStatus, TaskStatusSchema } from "./types.js";

export const DEFAULT_GITHUB_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "status:todo",
  queued: "status:queued",
  doing: "status:doing",
  review: "status:review",
  changes_requested: "status:changes-requested",
  blocked: "status:blocked",
  paused: "status:paused",
  done: "status:done",
  cancelled: "status:cancelled",
};

const GithubLabelSchema = z.string().trim().min(1).max(50);
export const GithubSyncConfigSchema = z
  .object({
    enabled: z.boolean(),
    status_labels: z
      .object({
        todo: GithubLabelSchema,
        queued: GithubLabelSchema,
        doing: GithubLabelSchema,
        review: GithubLabelSchema,
        changes_requested: GithubLabelSchema,
        blocked: GithubLabelSchema,
        paused: GithubLabelSchema,
        done: GithubLabelSchema,
        cancelled: GithubLabelSchema,
      })
      .default(DEFAULT_GITHUB_STATUS_LABELS),
  })
  .refine((config) => {
    const labels = Object.values(config.status_labels).map((label) => label.toLowerCase());
    return new Set(labels).size === labels.length;
  }, "Each status must have a distinct GitHub label");
export type GithubSyncConfig = z.infer<typeof GithubSyncConfigSchema>;

export const GithubSyncStateSchema = z.object({
  synced_at: z.string().nullable(),
  error: z.string().nullable(),
});
export type GithubSyncState = z.infer<typeof GithubSyncStateSchema>;

export const GithubTaskSyncSchema = z.object({
  issue_id: z.string(),
  repo: z.string(),
  number: z.number().int().positive(),
  status: TaskStatusSchema,
  remote_updated_at: z.string(),
  pending_status: TaskStatusSchema.nullable().optional(),
  synced_at: z.string().nullable(),
  error: z.string().nullable(),
});
export type GithubTaskSync = z.infer<typeof GithubTaskSyncSchema>;

export function githubRepository(remote: string | null | undefined): string | null {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(
      remote?.trim() ?? "",
    );
  const repo = match?.[1];
  if (!repo || repo.split("/").some((part) => part === "." || part === "..")) return null;
  return repo;
}

export function validateGithubTaskEdit(
  task: {
    github_sync?: unknown;
    title: string;
    body: string | null;
    github_issue: string | null;
    project_id: string | null;
  },
  patch: {
    title?: string | undefined;
    body?: string | null | undefined;
    github_issue?: string | null | undefined;
    project_id?: string | null | undefined;
  },
): void {
  if (!task.github_sync) return;
  for (const field of ["title", "body", "github_issue", "project_id"] as const) {
    if (patch[field] !== undefined && patch[field] !== task[field])
      throw new ValidationError(
        "Edit linked issue titles and descriptions in GitHub; issue identity and project are fixed while linked",
      );
  }
}

export function githubIssueStatus(
  issue: { state: string; state_reason?: string | null | undefined; labels: { name: string }[] },
  config: GithubSyncConfig,
): TaskStatus {
  if (issue.state === "closed") return issue.state_reason === "not_planned" ? "cancelled" : "done";
  const names = new Set(issue.labels.map((label) => label.name.toLowerCase()));
  const matches = TaskStatusSchema.options.filter((status) =>
    names.has(config.status_labels[status].toLowerCase()),
  );
  if (matches.length > 1)
    throw new Error("Conflicting GitHub status labels; keep exactly one mapped status label");
  const status = matches[0] ?? "todo";
  if (status === "done" || status === "cancelled")
    throw new Error(
      "Open issue has a terminal status label; close the issue or change its status label",
    );
  return status;
}
