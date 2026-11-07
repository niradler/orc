import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { useProject } from "@/hooks/useProjects";

export function ProjectGithubSync({ projectId }: { projectId?: string }) {
  const { data: project } = useProject(projectId ?? null);
  const queryClient = useQueryClient();
  const sync = useMutation({
    mutationFn: () => api.projects.syncGithub(projectId as string),
    onSuccess: () => {
      for (const key of ["tasks", "task", "projects", "project", "project-summary"])
        void queryClient.invalidateQueries({ queryKey: [key] });
    },
  });
  if (!project?.github_sync?.enabled) return null;
  const error = sync.error?.message ?? sync.data?.error ?? project.github_sync_state?.error;
  return (
    <div
      data-testid="project-github-sync"
      className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
    >
      <span>
        GitHub issues ·{" "}
        {project.github_sync_state?.synced_at
          ? `last synced ${new Date(project.github_sync_state.synced_at).toLocaleTimeString()}`
          : "awaiting first sync"}
      </span>
      <Button
        variant="ghost"
        size="sm"
        data-testid="github-sync-now"
        disabled={sync.isPending || project.status !== "active"}
        onClick={() => sync.mutate()}
      >
        {sync.isPending ? "Syncing…" : "Sync now"}
      </Button>
      {error && (
        <p role="alert" className="w-full text-error">
          {error}
        </p>
      )}
    </div>
  );
}
