import type { KbDocumentListing } from "@orc/core/kb";
import { ArrowLeft, Pencil, Tag, Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useInvalidateKb } from "@/hooks/useKnowledge";

type LabelAction = { kind: "rename" | "merge"; label: string } | { kind: "delete"; label: string };

export function KbLabelsPage({
  kbId,
  kbName,
  listing,
  onBack,
  onOpenLabel,
}: {
  kbId: string;
  kbName: string;
  listing: KbDocumentListing | undefined;
  onBack: () => void;
  onOpenLabel: (label: string) => void;
}) {
  const invalidate = useInvalidateKb();
  const [action, setAction] = useState<LabelAction | null>(null);
  const [target, setTarget] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const labels = [...(listing?.labels ?? [])].sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label),
  );
  const labelled = new Set(labels.map((item) => item.label));
  const unlabelled = (listing?.documents ?? []).filter((doc) =>
    doc.labels.every((label) => !labelled.has(label)),
  ).length;

  async function run() {
    if (!action) return;
    setBusy(true);
    setError(null);
    try {
      await api.kb.manageLabel(kbId, {
        action: action.kind,
        label: action.label,
        ...(action.kind !== "delete" ? { to: target.trim() } : {}),
      });
      await invalidate();
      setAction(null);
      setTarget("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Label change failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      data-testid="kb-labels-page"
      aria-label="Labels"
      className="w-full min-w-0 space-y-5 p-4 sm:p-6"
    >
      <header className="space-y-1">
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs text-outline hover:text-on-surface"
          onClick={onBack}
          data-testid="kb-labels-back"
        >
          <ArrowLeft size={13} /> {kbName}
        </button>
        <h1 className="text-2xl font-medium tracking-tight">Labels</h1>
        <p className="text-sm text-outline">
          Labels are search facets and list filters. Renaming or merging keeps paths, links and
          citations unchanged.
        </p>
      </header>
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      {labels.length === 0 ? (
        <p className="text-sm text-outline" data-testid="kb-labels-empty">
          No labels yet. Add labels from a document or the intake review.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-sm" data-testid="kb-labels-table">
            <thead>
              <tr className="border-b border-outline-variant text-left text-xs text-outline">
                <th className="py-2 pr-3 font-normal">Label</th>
                <th className="w-20 py-2 pr-3 text-right font-normal">Documents</th>
                <th className="w-20 py-2 pr-3 text-right font-normal">Reads</th>
                <th className="w-28 py-2 pr-3 font-normal">Last updated</th>
                <th className="w-24 py-2 text-right font-normal">Actions</th>
              </tr>
            </thead>
            <tbody>
              {labels.map((item) => (
                <tr
                  key={item.label}
                  data-testid="kb-label-row"
                  data-label={item.label}
                  className="border-b border-outline-variant/60"
                >
                  <td className="py-1 pr-3">
                    <button
                      type="button"
                      className="inline-flex min-h-8 items-center gap-1.5 text-left hover:text-primary"
                      onClick={() => onOpenLabel(item.label)}
                    >
                      <Tag size={13} className="text-outline" aria-hidden />
                      {item.label}
                    </button>
                  </td>
                  <td className="py-1 pr-3 text-right tabular-nums">{item.count}</td>
                  <td className="py-1 pr-3 text-right tabular-nums text-outline">{item.reads}</td>
                  <td className="py-1 pr-3 text-xs text-outline">
                    {item.updated_at ? new Date(item.updated_at).toLocaleDateString() : ""}
                  </td>
                  <td className="py-1 text-right">
                    <LabelMenu
                      label={item.label}
                      onAction={(kind) => {
                        setAction({ kind, label: item.label });
                        setTarget(kind === "merge" ? "" : item.label);
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-outline" data-testid="kb-labels-unlabelled">
        {unlabelled} document{unlabelled === 1 ? "" : "s"} without labels
      </p>

      <Dialog open={action !== null} onOpenChange={(open) => !open && setAction(null)}>
        <DialogContent className="max-w-md" data-testid="kb-label-dialog">
          <DialogHeader>
            <DialogTitle>
              {action?.kind === "delete"
                ? `Delete ${action.label}`
                : action?.kind === "merge"
                  ? `Merge ${action.label}`
                  : `Rename ${action?.label}`}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {action?.kind === "delete" ? (
              <p className="text-sm">
                Delete the label <strong>{action.label}</strong> from every document? The documents
                stay.
              </p>
            ) : (
              <>
                <Label htmlFor="kb-label-target" className="text-xs">
                  {action?.kind === "merge" ? "Merge into" : "Rename to"}
                </Label>
                <Input
                  id="kb-label-target"
                  data-testid="kb-label-target"
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                  list="kb-label-targets"
                  placeholder="label"
                />
                <datalist id="kb-label-targets">
                  {labels
                    .filter((entry) => entry.label !== action?.label)
                    .map((entry) => (
                      <option key={entry.label} value={entry.label} />
                    ))}
                </datalist>
                <p className="text-xs text-outline">
                  {action?.kind === "merge"
                    ? `Documents labelled ${action?.label} also get the target label.`
                    : "Documents update to the new label; paths and links do not change."}
                </p>
              </>
            )}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setAction(null)} disabled={busy}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant={action?.kind === "delete" ? "destructive" : "default"}
                disabled={busy || (action?.kind !== "delete" && !target.trim())}
                onClick={() => void run()}
                data-testid="kb-label-confirm"
              >
                {action?.kind === "delete"
                  ? "Delete label"
                  : action?.kind === "merge"
                    ? "Merge"
                    : "Rename"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function LabelMenu({
  label,
  onAction,
}: {
  label: string;
  onAction: (kind: "rename" | "merge" | "delete") => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Actions for ${label}`}
          data-testid="kb-label-menu"
        >
          <Pencil size={13} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-44 p-1">
        <button
          type="button"
          data-testid="kb-label-rename"
          className="flex min-h-8 w-full items-center gap-2 rounded px-2 text-left text-sm hover:bg-surface-high"
          onClick={() => onAction("rename")}
        >
          <Pencil size={13} /> Rename
        </button>
        <button
          type="button"
          data-testid="kb-label-merge"
          className="flex min-h-8 w-full items-center gap-2 rounded px-2 text-left text-sm hover:bg-surface-high"
          onClick={() => onAction("merge")}
        >
          <Tag size={13} /> Merge
        </button>
        <button
          type="button"
          data-testid="kb-label-delete"
          className="flex min-h-8 w-full items-center gap-2 rounded px-2 text-left text-sm text-error hover:bg-surface-high"
          onClick={() => onAction("delete")}
        >
          <Trash2 size={13} /> Delete
        </button>
      </PopoverContent>
    </Popover>
  );
}
