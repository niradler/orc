import { useState } from "react";
import type { Task } from "@/api/client";
import { useUpdateTask } from "@/hooks/useTasks";

const fields = ["git_repo", "git_branch", "git_worktree", "github_issue", "github_pr"] as const;
const labels = {
  git_repo: "Repository folder",
  git_branch: "Branch",
  git_worktree: "Worktree folder",
  github_issue: "GitHub issue URL",
  github_pr: "GitHub PR URL",
};
export function TaskGitLinks({ task }: { task: Task }) {
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState(
    () =>
      Object.fromEntries(fields.map((field) => [field, task[field] ?? ""])) as Record<
        (typeof fields)[number],
        string
      >,
  );
  const update = useUpdateTask();
  return (
    <section data-testid="task-git-links" className="space-y-2 text-xs">
      <div className="flex justify-between">
        <strong>Git / GitHub</strong>
        <button
          type="button"
          data-testid="task-git-edit"
          onClick={() => {
            setValues(
              Object.fromEntries(
                fields.map((field) => [field, task[field] ?? ""]),
              ) as typeof values,
            );
            setEditing(!editing);
          }}
        >
          Edit links
        </button>
      </div>
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            update.mutate(
              {
                id: task.id,
                ...Object.fromEntries(fields.map((field) => [field, values[field].trim() || null])),
              },
              { onSuccess: () => setEditing(false) },
            );
          }}
          className="space-y-2"
        >
          {fields.map((field) => (
            <label className="block" key={field}>
              {labels[field]}
              <input
                data-testid={`task-link-${field}`}
                className="w-full bg-surface-highest p-2"
                value={values[field]}
                onChange={(event) => setValues({ ...values, [field]: event.target.value })}
              />
            </label>
          ))}
          <button
            type="submit"
            data-testid="task-git-save"
            disabled={update.isPending}
            className="text-primary"
          >
            Save links
          </button>
          {update.error && <p role="alert">{update.error.message}</p>}
        </form>
      ) : (
        <div className="space-y-1">
          {fields.map((field) =>
            task[field] ? (
              <p className="break-all" key={field}>
                {labels[field]}:{" "}
                {field.startsWith("github_") ? (
                  <a
                    href={task[field] ?? ""}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary"
                  >
                    {task[field]}
                  </a>
                ) : (
                  task[field]
                )}
              </p>
            ) : null,
          )}
          {!fields.some((field) => task[field]) && (
            <p className="text-outline">
              No links yet. Link a checkout from its terminal Git panel, or edit here.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
