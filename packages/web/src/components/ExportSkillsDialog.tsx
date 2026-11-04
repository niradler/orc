import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client";
import { HelpPopover } from "@/components/HelpPopover";
import { MatchNote, NativeFolderField } from "@/components/NativeFolderField";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const STATUS_LABEL: Record<string, string> = {
  new: "",
  identical: "Already there",
  near: "Near copy there, overwrite to replace",
  conflict: "Different skill with this name there, overwrite to replace",
  duplicate: "Already there under another name",
  blocked: "Cannot be written",
};

const FOLDER = "__folder__";

export function ExportSkillsDialog({ onClose }: { onClose: () => void }) {
  const [targetId, setTargetId] = useState("");
  const [folderDraft, setFolderDraft] = useState("");
  const [folder, setFolder] = useState("");
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const queryClient = useQueryClient();
  const agents = useQuery({
    queryKey: ["skills", "local-agents", ""],
    queryFn: () => api.skills.localAgents(),
  });
  const target =
    targetId === FOLDER
      ? folder
        ? { path: folder }
        : null
      : targetId
        ? { agent: targetId }
        : null;
  const plan = useQuery({
    queryKey: ["skills", "export-plan", target],
    queryFn: () => api.skills.previewExport(target ?? { path: "" }),
    enabled: Boolean(target),
  });
  const exporting = useMutation({
    mutationFn: (input: { names: string[]; overwrite: string[] }) =>
      api.skills.exportTo(target ?? { path: "" }, input.names, input.overwrite),
    onSuccess: async (result) => {
      setPicked({});
      await queryClient.invalidateQueries({ queryKey: ["skills"] });
      if (!result.skipped.length) onClose();
    },
  });
  const busy = exporting.isPending;
  const items = target ? (plan.data?.skills ?? []) : [];
  const chosen = items.filter(
    (item) => (item.status === "new" || item.can_overwrite) && picked[item.name],
  );
  const fresh = items.filter((item) => item.status === "new");
  const changeTarget = (next: string) => {
    setTargetId(next);
    setPicked({});
    exporting.reset();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        closeDisabled={busy}
        className="flex min-w-0 w-[min(800px,calc(100vw-2rem))] max-w-none max-h-[calc(var(--app-height,100dvh)-2rem)] flex-col gap-0 overflow-hidden p-0"
      >
        <DialogHeader className="shrink-0 flex-row items-center gap-1 border-b px-4 py-3 pr-12 sm:px-6">
          <DialogTitle>Export to agents</DialogTitle>
          <HelpPopover label="skill exports">
            Writes ORC skills as native skill folders (SKILL.md plus supporting files) into an
            agent's skills folder or any folder. Existing folders are only replaced when you select
            them, and a backup is kept.
          </HelpPopover>
        </DialogHeader>
        <div
          className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6"
          data-testid="skill-export-body"
        >
          <div className="space-y-2">
            <label htmlFor="skill-export-target" className="text-sm font-medium">
              Destination
            </label>
            <select
              id="skill-export-target"
              data-testid="skill-export-target"
              className="block h-11 w-full rounded-md border border-input bg-background px-3 text-sm sm:h-8"
              value={targetId}
              disabled={busy}
              onChange={(event) => changeTarget(event.target.value)}
            >
              <option value="">Choose a destination</option>
              {(agents.data?.agents ?? []).map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.label} ({agent.dir})
                </option>
              ))}
              <option value={FOLDER}>Custom folder</option>
            </select>
            {targetId === FOLDER && (
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
                    id="skill-export-folder"
                    label="Folder"
                    value={folderDraft}
                    disabled={busy}
                    onChange={setFolderDraft}
                  />
                </div>
                <Button
                  type="submit"
                  variant="outline"
                  data-testid="skill-export-folder-apply"
                  disabled={busy || !folderDraft.trim()}
                >
                  Compare
                </Button>
              </form>
            )}
          </div>
          {plan.isLoading && target && <p role="status">Comparing with the destination…</p>}
          {plan.data && target && (
            <section data-testid="skill-export-plan" className="space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 flex-1 text-xs text-outline wrap-break-word">
                  {plan.data.dir}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="skill-export-select-new"
                  disabled={busy || !fresh.length}
                  onClick={() =>
                    setPicked({
                      ...picked,
                      ...Object.fromEntries(fresh.map((item) => [item.name, true])),
                    })
                  }
                >
                  Select all new ({fresh.length})
                </Button>
              </div>
              <div className="divide-y divide-border">
                {items.map((item) => {
                  const selectable = item.status === "new" || item.can_overwrite;
                  return (
                    <label
                      key={item.name}
                      className="flex min-h-11 min-w-0 items-start gap-3 py-2 text-sm"
                      data-testid="skill-export-item"
                      data-skill-name={item.name}
                      data-status={item.status}
                    >
                      <input
                        type="checkbox"
                        aria-label={`Export ${item.name}`}
                        className="mt-1 shrink-0"
                        data-testid="skill-export-select"
                        checked={selectable && Boolean(picked[item.name])}
                        disabled={busy || !selectable}
                        onChange={(event) =>
                          setPicked({ ...picked, [item.name]: event.target.checked })
                        }
                      />
                      <span className="min-w-0 wrap-break-word">
                        <span className="font-medium">{item.name}</span>
                        {STATUS_LABEL[item.status] && (
                          <span className="ml-2 text-xs text-outline">
                            {STATUS_LABEL[item.status]}
                          </span>
                        )}
                        <MatchNote match={item.match} folder="the destination" />
                        {item.reason && item.status === "blocked" && (
                          <span className="block text-xs text-destructive">{item.reason}</span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            </section>
          )}
          {exporting.data?.skipped.map((skip) => (
            <p key={skip.name} role="alert" className="text-xs text-destructive">
              Skipped {skip.name}: {skip.reason}
            </p>
          ))}
          {(agents.error || plan.error || exporting.error) && (
            <p role="alert" className="text-sm text-destructive">
              {(agents.error || plan.error || exporting.error)?.message}
            </p>
          )}
        </div>
        <DialogFooter className="shrink-0 border-t px-4 py-3 sm:px-6">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Close
          </Button>
          <Button
            data-testid="skill-export-submit"
            disabled={busy || !chosen.length}
            onClick={() =>
              exporting.mutate({
                names: chosen.map((item) => item.name),
                overwrite: chosen.filter((item) => item.status !== "new").map((item) => item.name),
              })
            }
          >
            {busy ? "Exporting…" : `Export selected${chosen.length ? ` (${chosen.length})` : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
