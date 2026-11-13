import { useQuery } from "@tanstack/react-query";
import { api, type WorkspaceRecord } from "@/api/client";

/** Prepared workspace for a folder: setup state, port block and preview link. */
export function useWorkspaceByPath(path: string | null | undefined) {
  return useQuery({
    queryKey: ["workspaces", "path", path],
    queryFn: () => api.workspaces.byPath(path as string),
    enabled: !!path,
    refetchInterval: (query) =>
      query.state.data?.setup_status === "running" || query.state.data?.setup_status === "pending"
        ? 2000
        : false,
  });
}

export function workspacePortRange(workspace: WorkspaceRecord): string | null {
  if (workspace.port_base == null) return null;
  const count = workspace.port_count ?? 1;
  return count > 1
    ? `${workspace.port_base}–${workspace.port_base + count - 1}`
    : `${workspace.port_base}`;
}

const STATUS_LABEL: Record<WorkspaceRecord["setup_status"], string> = {
  pending: "Not started",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  skipped: "No setup script",
};

export function workspaceSetupLabel(workspace: WorkspaceRecord): string {
  return STATUS_LABEL[workspace.setup_status];
}

export function WorkspaceStatus({
  path,
  showOutput = false,
}: {
  path: string | null | undefined;
  showOutput?: boolean;
}) {
  const { data: workspace } = useWorkspaceByPath(path);
  if (!workspace) return null;
  const ports = workspacePortRange(workspace);
  return (
    <section data-testid="workspace-status" className="space-y-1 text-xs">
      <strong>Workspace</strong>
      {ports && <p data-testid="workspace-ports">Ports: {ports}</p>}
      <p data-testid="workspace-setup-status">
        Setup: {workspaceSetupLabel(workspace)}
        {workspace.setup_status === "failed" && workspace.setup_output ? ". See output" : ""}
      </p>
      {workspace.preview_url && (
        <p>
          Preview:{" "}
          <a
            data-testid="workspace-preview"
            href={workspace.preview_url}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline"
          >
            {workspace.preview_url}
          </a>
        </p>
      )}
      {showOutput && workspace.setup_output && (
        <details data-testid="workspace-setup-output">
          <summary className="cursor-pointer text-on-surface-variant">Setup output</summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-highest p-2 text-[11px]">
            {workspace.setup_output}
          </pre>
        </details>
      )}
    </section>
  );
}
