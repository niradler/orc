import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client";
import { HelpPopover } from "@/components/HelpPopover";
import { MatchNote, NativeFolderField, type TransferMatch } from "@/components/NativeFolderField";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Mode = "import" | "export";
type Row = {
  name: string;
  description: string;
  status: string;
  selectable: boolean;
  match?: TransferMatch | undefined;
  error?: string | undefined;
};

const IMPORT_LABEL: Record<string, string> = {
  new: "",
  installed: "Already in ORC",
  duplicate: "Near copy already in ORC",
  conflict: "Name taken in ORC (different content), select to replace",
  invalid: "Invalid",
};
const EXPORT_LABEL: Record<string, string> = {
  new: "",
  identical: "Already in the folder",
  near: "Near copy in the folder, select to overwrite",
  conflict: "Different memory with this name in the folder, select to overwrite",
  duplicate: "Already in the folder under another name",
};

const FOLDER = "__folder__";

export function MemoryTransferDialog({
  mode,
  initialProjectId,
  projects,
  onClose,
}: {
  mode: Mode;
  initialProjectId: string | null;
  projects: { id: string; name: string }[];
  onClose: () => void;
}) {
  const [projectId, setProjectId] = useState(initialProjectId ?? "");
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [folderDraft, setFolderDraft] = useState("");
  const [folder, setFolder] = useState("");
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const queryClient = useQueryClient();
  const sources = useQuery({
    queryKey: ["memory-transfer", "sources", projectId],
    queryFn: () => api.memories.nativeSources(projectId),
    enabled: Boolean(projectId),
  });
  const list = sources.data?.sources ?? [];
  const chosenSource = sourceId ?? list.find((source) => source.project_match)?.dir ?? "";
  const dir = chosenSource === FOLDER ? folder : chosenSource;
  const preview = useQuery({
    queryKey: ["memory-transfer", mode, projectId, dir],
    queryFn: async (): Promise<{ dir: string; index?: boolean; rows: Row[] }> => {
      if (mode === "import") {
        const data = await api.memories.previewImport(projectId, dir);
        return {
          dir: data.dir,
          rows: data.memories.map((memory) => ({
            ...memory,
            selectable: memory.status === "new" || memory.can_replace,
          })),
        };
      }
      const data = await api.memories.previewExport(projectId, dir);
      return {
        dir: data.dir,
        index: data.index,
        rows: data.memories.map((item) => ({
          ...item,
          selectable: item.status === "new" || item.can_overwrite,
          ...(item.status === "duplicate" ? { error: item.reason } : {}),
        })),
      };
    },
    enabled: Boolean(projectId && dir),
  });
  const transfer = useMutation({
    mutationFn: async (rows: Row[]) => {
      if (mode === "import") {
        const result = await api.memories.importNative(
          projectId,
          dir,
          rows.map((row) => ({
            name: row.name,
            ...(row.status === "new" ? {} : { replace: true }),
          })),
        );
        return {
          done: [
            ...result.imported.map((name) => `Imported ${name}`),
            ...result.replaced.map((name) => `Replaced ${name}`),
          ],
          skipped: result.skipped,
        };
      }
      const result = await api.memories.exportNative(
        projectId,
        dir,
        rows.map((row) => row.name),
        rows.filter((row) => row.status !== "new").map((row) => row.name),
      );
      return {
        done: result.exported.map((item) => `${item.replaced ? "Replaced" : "Wrote"} ${item.file}`),
        skipped: result.skipped,
      };
    },
    onSuccess: async (result) => {
      setPicked({});
      await queryClient.invalidateQueries({ queryKey: ["memory-transfer"] });
      if (mode === "import") await queryClient.invalidateQueries({ queryKey: ["memories"] });
      if (!result.skipped.length) onClose();
    },
  });
  const busy = transfer.isPending;
  const rows = projectId && dir ? (preview.data?.rows ?? []) : [];
  const chosen = rows.filter((row) => row.selectable && picked[row.name]);
  const fresh = rows.filter((row) => row.status === "new");
  const labels = mode === "import" ? IMPORT_LABEL : EXPORT_LABEL;
  const verb = mode === "import" ? "Import" : "Export";
  const testId = `memory-${mode}`;
  const error = sources.error || preview.error || transfer.error;
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        closeDisabled={busy}
        data-testid={`${testId}-dialog`}
        className="flex min-w-0 w-[min(800px,calc(100vw-2rem))] max-w-none max-h-[calc(var(--app-height,100dvh)-2rem)] flex-col gap-0 overflow-hidden p-0"
      >
        <DialogHeader className="shrink-0 flex-row items-center gap-1 border-b px-4 py-3 pr-12 sm:px-6">
          <DialogTitle>
            {mode === "import" ? "Import native memories" : "Export memories"}
          </DialogTitle>
          <HelpPopover label={`memory ${mode}`}>
            {mode === "import"
              ? "Reads Claude Code memory files (~/.claude/projects/<project>/memory/*.md), Codex notes (~/.codex/memories/extensions/ad_hoc/notes) or any folder of memory files into this project. Near copies are flagged so a small edit does not create a duplicate."
              : "Writes this project's memories as memory files: Claude Code folders also get a MEMORY.md index, and Codex merges its notes into its memory. Existing files are only replaced when you select them, and a backup is kept."}
          </HelpPopover>
        </DialogHeader>
        <div
          className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6"
          data-testid={`${testId}-body`}
        >
          <div className="space-y-2">
            <label htmlFor={`${testId}-project`} className="text-sm font-medium">
              {mode === "import" ? "Into project" : "From project"}
            </label>
            <select
              id={`${testId}-project`}
              data-testid={`${testId}-project`}
              className="block h-11 w-full rounded-md border border-input bg-background px-3 text-sm sm:h-8"
              value={projectId}
              disabled={busy}
              onChange={(event) => {
                setProjectId(event.target.value);
                setSourceId(null);
                setPicked({});
                transfer.reset();
              }}
            >
              <option value="">Choose a project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <label htmlFor={`${testId}-source`} className="text-sm font-medium">
              {mode === "import" ? "Source" : "Destination"}
            </label>
            <select
              id={`${testId}-source`}
              data-testid={`${testId}-source`}
              className="block h-11 w-full rounded-md border border-input bg-background px-3 text-sm sm:h-8"
              value={chosenSource}
              disabled={busy || !projectId || sources.isLoading}
              onChange={(event) => {
                setSourceId(event.target.value);
                setPicked({});
                transfer.reset();
              }}
            >
              <option value="">Choose a folder</option>
              {list.map((source) => (
                <option key={source.dir} value={source.dir}>
                  {source.label} · {source.count} {source.count === 1 ? "memory" : "memories"}
                  {source.project_match ? " · this project" : ""}
                </option>
              ))}
              <option value={FOLDER}>Custom folder</option>
            </select>
            {chosenSource === FOLDER && (
              <form
                className="flex flex-col gap-2 sm:flex-row sm:items-end"
                onSubmit={(event) => {
                  event.preventDefault();
                  setPicked({});
                  setFolder(folderDraft.trim());
                }}
              >
                <div className="min-w-0 flex-1">
                  <NativeFolderField
                    id={`${testId}-folder`}
                    label="Folder"
                    value={folderDraft}
                    disabled={busy}
                    onChange={setFolderDraft}
                  />
                </div>
                <Button
                  type="submit"
                  variant="outline"
                  data-testid={`${testId}-folder-apply`}
                  disabled={busy || !folderDraft.trim()}
                >
                  {mode === "import" ? "Scan" : "Compare"}
                </Button>
              </form>
            )}
          </div>
          {preview.isLoading && projectId && dir && <p role="status">Reading the folder…</p>}
          {preview.data && projectId && dir && (
            <section data-testid={`${testId}-plan`} className="space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 flex-1 text-xs text-outline wrap-break-word">
                  {preview.data.dir}
                  {preview.data.index ? " · MEMORY.md index is updated" : ""}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid={`${testId}-select-new`}
                  disabled={busy || !fresh.length}
                  onClick={() =>
                    setPicked({
                      ...picked,
                      ...Object.fromEntries(fresh.map((row) => [row.name, true])),
                    })
                  }
                >
                  Select all new ({fresh.length})
                </Button>
              </div>
              {!rows.length && (
                <p role="status">
                  {mode === "import"
                    ? "No memory files in this folder."
                    : "This project has no memories."}
                </p>
              )}
              <div className="divide-y divide-border">
                {rows.map((row) => (
                  <label
                    key={row.name}
                    className="flex min-h-11 min-w-0 items-start gap-3 py-2 text-sm"
                    data-testid={`${testId}-item`}
                    data-memory-name={row.name}
                    data-status={row.status}
                  >
                    <input
                      type="checkbox"
                      aria-label={`${verb} ${row.name}`}
                      className="mt-1 shrink-0"
                      data-testid={`${testId}-select`}
                      checked={row.selectable && Boolean(picked[row.name])}
                      disabled={busy || !row.selectable}
                      onChange={(event) =>
                        setPicked({ ...picked, [row.name]: event.target.checked })
                      }
                    />
                    <span className="min-w-0 wrap-break-word">
                      <span className="font-medium">{row.name}</span>
                      {labels[row.status] && (
                        <span className="ml-2 text-xs text-outline">{labels[row.status]}</span>
                      )}
                      <span className="mt-0.5 line-clamp-2 text-xs leading-4 text-outline">
                        {row.description}
                      </span>
                      <MatchNote match={row.match} />
                      {row.error && (
                        <span className="block text-xs text-destructive">{row.error}</span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            </section>
          )}
          {transfer.data?.skipped.map((skip) => (
            <p key={skip.name} role="alert" className="text-xs text-destructive">
              Skipped {skip.name}: {skip.reason}
            </p>
          ))}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error.message}
            </p>
          )}
        </div>
        <DialogFooter className="shrink-0 border-t px-4 py-3 sm:px-6">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Close
          </Button>
          <Button
            data-testid={`${testId}-submit`}
            disabled={busy || !chosen.length}
            onClick={() => transfer.mutate(chosen)}
          >
            {busy
              ? `${verb === "Import" ? "Importing" : "Exporting"}…`
              : `${verb} selected${chosen.length ? ` (${chosen.length})` : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
