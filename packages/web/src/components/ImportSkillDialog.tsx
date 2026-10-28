import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client";
import { BulkActionBar } from "@/components/BulkActionBar";
import { HelpPopover } from "@/components/HelpPopover";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useListSelection } from "@/hooks/useListSelection";

export function ImportSkillDialog({ onClose }: { onClose: () => void }) {
  const [source, setSource] = useState("");
  const [importedPaths, setImportedPaths] = useState<string[]>([]);
  const queryClient = useQueryClient();
  const discover = useMutation({
    mutationFn: api.skills.discover,
    onSuccess: () => {
      selection.clear();
      setImportedPaths([]);
    },
  });
  const selection = useListSelection(
    (discover.data?.skills ?? [])
      .filter((skill) => !skill.installed && !importedPaths.includes(skill.path))
      .map((skill) => skill.path),
    `${source}:${discover.data?.commit ?? ""}`,
  );
  const selected = selection.selectedIds;
  const importing = useMutation({
    mutationFn: async () => {
      if (!discover.data) throw new Error("Discover skills first");
      const failed: { path: string; error: string }[] = [];
      const imported: string[] = [];
      for (let offset = 0; offset < selected.length; offset += 16) {
        const paths = selected.slice(offset, offset + 16);
        try {
          await api.skills.import({ source: source.trim(), commit: discover.data.commit, paths });
          imported.push(...paths);
        } catch (error) {
          failed.push(
            ...paths.map((path) => ({
              path,
              error: error instanceof Error ? error.message : "Import failed",
            })),
          );
        }
      }
      return { imported, failed };
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["skills"] });
      setImportedPaths((paths) => [...paths, ...result.imported]);
      selection.select(result.failed.map((item) => item.path));
      if (!result.failed.length) onClose();
    },
  });
  const busy = discover.isPending || importing.isPending;
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        closeDisabled={busy}
        className="flex min-w-0 w-[min(800px,calc(100vw-2rem))] max-w-none max-h-[calc(var(--app-height,100dvh)-2rem)] flex-col gap-0 overflow-hidden p-0"
      >
        <DialogHeader className="shrink-0 flex-row items-center gap-1 border-b px-4 py-3 pr-12 sm:px-6">
          <DialogTitle>Import from GitHub</DialogTitle>
          <HelpPopover label="skill imports">
            GitHub repositories, owner/repo, skill-folder URLs and skills.sh links are supported.
            Private repositories use gh login on the execution host or ORC_GITHUB_TOKEN on the ORC
            server. Supporting files are included.
          </HelpPopover>
        </DialogHeader>
        <div
          className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6"
          data-testid="skill-import-body"
        >
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              discover.mutate(source.trim());
            }}
          >
            <Label htmlFor="skill-repository">Repository or skills.sh link</Label>
            <Input
              id="skill-repository"
              data-testid="skill-repository-input"
              value={source}
              disabled={busy}
              onChange={(event) => {
                setSource(event.target.value);
                discover.reset();
                importing.reset();
                selection.clear();
                setImportedPaths([]);
              }}
              placeholder="https://github.com/vercel-labs/agent-skills"
              autoFocus
            />
            <Button type="submit" data-testid="skill-discover" disabled={busy || !source.trim()}>
              {discover.isPending ? "Discovering…" : "Discover skills"}
            </Button>
          </form>
          {discover.data && (
            <div className="space-y-2">
              <p className="text-xs text-outline">
                {discover.data.skills.length} skills found · {discover.data.commit.slice(0, 8)}
              </p>
              {!discover.data.skills.length && (
                <p role="status">No valid skills found in this source.</p>
              )}
              <BulkActionBar
                resourceLabel="new skills"
                count={selected.length}
                allSelected={selection.allSelected}
                someSelected={selection.someSelected}
                onSelectAll={selection.selectAll}
                onClear={selection.clear}
                disabled={busy}
              >
                {null}
              </BulkActionBar>
              <div className="divide-y divide-border">
                {discover.data.skills.map((skill) => (
                  <div
                    key={skill.path}
                    className="min-w-0 py-2"
                    data-testid="remote-skill"
                    data-skill-name={skill.name}
                  >
                    <label className="flex min-h-11 min-w-0 items-center gap-3 text-sm md:min-h-6 pointer-coarse:min-h-11">
                      <input
                        type="checkbox"
                        className="mt-1 shrink-0"
                        data-testid="remote-skill-select"
                        checked={selected.includes(skill.path)}
                        disabled={busy || skill.installed || importedPaths.includes(skill.path)}
                        onChange={() => selection.toggle(skill.path)}
                      />
                      <span className="min-w-0 text-sm wrap-break-word">
                        <span className="font-medium">{skill.name}</span>
                        {(skill.installed || importedPaths.includes(skill.path)) && (
                          <span className="ml-2 text-xs text-outline">Already installed</span>
                        )}
                      </span>
                    </label>
                    <details className="min-w-0 pl-6">
                      <summary
                        data-testid="remote-skill-details"
                        aria-label={`Details for ${skill.name}`}
                        className="flex min-h-11 cursor-pointer items-center gap-2 rounded-sm text-xs text-outline md:min-h-8 pointer-coarse:min-h-11"
                      >
                        <span className="min-w-0 flex-1 truncate">{skill.description}</span>
                        <span className="shrink-0">Details</span>
                      </summary>
                      <div className="space-y-1 pb-2 text-xs wrap-break-word">
                        <p>{skill.description}</p>
                        <p className="text-outline">{skill.path || "Repository root"}</p>
                      </div>
                    </details>
                  </div>
                ))}
              </div>
              {discover.data.issues.map((issue) => (
                <p key={issue.path} role="alert" className="text-xs text-destructive">
                  {issue.path}: {issue.error}
                </p>
              ))}
            </div>
          )}
          {(discover.error || importing.error) && (
            <p role="alert" className="text-sm text-destructive">
              {(discover.error || importing.error)?.message}
            </p>
          )}
          {!!importing.data?.failed.length && (
            <div role="alert" className="text-sm text-destructive">
              <p>
                {importing.data.imported.length} imported; {importing.data.failed.length} failed.
                Failed selections retained for retry.
              </p>
              {importing.data.failed.map((item) => (
                <p key={item.path}>
                  {item.path || "Repository root"}: {item.error}
                </p>
              ))}
            </div>
          )}
        </div>
        <DialogFooter className="shrink-0 border-t px-4 py-3 sm:px-6">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            data-testid="skill-import-submit"
            disabled={busy || !discover.data || !selected.length}
            onClick={() => importing.mutate()}
          >
            {importing.isPending
              ? "Importing…"
              : `Import selected${selected.length ? ` (${selected.length})` : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
