import type { KbSource, KbSourceScan, KnowledgeBase } from "@orc/core/kb";
import { FolderOpen, FolderSync, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api } from "@/api/client";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorLine, Field, useAction } from "@/components/kb/KbDialogs";
import { ago } from "@/components/kb/KbDigest";
import { KbSetupRow, StateDot } from "@/components/kb/KbSetupRow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useInvalidateKb, useKbSources } from "@/hooks/useKnowledge";

function scanSummary(scan: KbSourceScan): string {
  return `${scan.added} added · ${scan.updated} updated · ${scan.missing} missing${scan.errors.length ? ` · ${scan.errors.length} errors: ${scan.errors.slice(0, 3).join("; ")}` : ""}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** ORC reads the folder on the machine it runs on, which is nearly always this one. */
function pathHint(): string {
  if (/win/i.test(navigator.platform))
    return "Choose a folder or type its full path, e.g. C:\\notes";
  if (/mac/i.test(navigator.platform))
    return "Choose a folder or type its full path, e.g. /Users/you/notes";
  return "Choose a folder or type its full path, e.g. /home/you/notes";
}

/** Exactly what stopping a folder's sync does, with counts. */
function stopSyncDescription(source: KbSource): string {
  const following = source.document_count - source.edited_count;
  const removed = following
    ? `${plural(following, "synced copy is", "synced copies are")} removed from this knowledge base`
    : "No synced copies are removed";
  const kept = source.edited_count
    ? `; ${plural(source.edited_count, "edited copy is", "edited copies are")} kept as documents`
    : "";
  return `Stop syncing ${source.root_path}? ${removed}${kept}. Files on disk are not touched.`;
}

function folderName(root: string): string {
  return (
    root
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || root
  );
}

/**
 * Folders on disk whose files are copied into this knowledge base and follow the file on each
 * scan until edited in ORC. ORC never writes the folder.
 */
export function KbFolders({ kb }: { kb: KnowledgeBase }) {
  const sources = useKbSources(kb.id);
  const invalidate = useInvalidateKb();
  const action = useAction();
  const [expanded, setExpanded] = useState(false);
  const [root, setRoot] = useState("");
  const [pattern, setPattern] = useState("**/*.md");
  const [result, setResult] = useState<string | null>(null);
  const [removing, setRemoving] = useState<KbSource | null>(null);
  const [adding, setAdding] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const list = sources.data ?? [];
  const failing = list.filter((s) => s.last_error).length;
  const documents = list.reduce((n, s) => n + s.document_count, 0);

  function openForm() {
    setExpanded(true);
    setAdding(true);
  }
  function closeForm() {
    setAdding(false);
    setRoot("");
    action.setError(null);
    // With no folders the form is all the row holds, so closing it collapses the row.
    if (list.length === 0) setExpanded(false);
  }

  async function chooseFolder() {
    setChoosing(true);
    action.setError(null);
    try {
      const { path } = await api.terminals.pickFolder(root.trim() || undefined);
      if (path) setRoot(path);
    } catch (error) {
      action.setError(error instanceof Error ? error.message : String(error));
    } finally {
      setChoosing(false);
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const added = await action.run(() =>
      api.kb.addSource(kb.id, { root_path: root.trim(), pattern: pattern.trim() || "**/*.md" }),
    );
    if (!added) return;
    setRoot("");
    setAdding(false);
    setResult(scanSummary(added.scan));
    await invalidate();
  }

  return (
    <KbSetupRow
      title="Synced folders"
      testId="kb-folders"
      toggleTestId="kb-sources"
      expanded={expanded}
      onExpandedChange={(open) => {
        setExpanded(open);
        // An empty row has nothing to show but the form.
        setAdding(open && list.length === 0);
      }}
      summary={
        sources.isLoading ? (
          <span className="text-outline">Loading…</span>
        ) : list.length === 0 ? (
          <span
            className="inline-flex items-center gap-1.5 text-outline"
            data-testid="kb-folders-none"
          >
            <StateDot tone="off" />
            None
          </span>
        ) : (
          <span
            className="inline-flex min-w-0 max-w-full items-center gap-1.5"
            data-testid="kb-folders-summary"
          >
            <StateDot tone={failing ? "error" : "ok"} />
            {list.length === 1 ? (
              <span className="min-w-0 truncate" title={list[0]?.root_path}>
                {folderName(list[0]?.root_path ?? "")}
              </span>
            ) : (
              `${list.length} folders`
            )}
            <span className="shrink-0 text-outline">
              · {documents} {documents === 1 ? "document" : "documents"}
              {failing ? ` · ${failing} failing` : ""}
            </span>
          </span>
        )
      }
      actions={
        list.length === 0 && !expanded ? (
          <Button size="sm" variant="outline" data-testid="kb-folders-add" onClick={openForm}>
            Add folder
          </Button>
        ) : null
      }
    >
      <div className="min-w-0 space-y-3">
        <p className="max-w-prose text-outline">
          Matching files are copied in and kept in sync: ORC rescans every minute while the daemon
          runs, or when you choose Scan now. A copy you edit here stops following its file. ORC
          never writes to the folder.
        </p>
        {list.length > 0 && (
          <ul className="divide-y divide-outline-variant" data-testid="kb-sources-list">
            {list.map((s) => (
              <li
                key={s.id}
                data-testid="kb-source-row"
                className="flex min-w-0 flex-wrap items-center gap-2 py-2"
              >
                <div className="min-w-0 flex-1 basis-56">
                  <div className="font-medium">{folderName(s.root_path)}</div>
                  <div className="break-all font-mono text-xs text-outline">{s.root_path}</div>
                  <div className="text-xs text-outline">
                    {s.pattern} · {plural(s.document_count, "document", "documents")}
                    {s.edited_count ? ` (${s.edited_count} edited)` : ""} ·{" "}
                    {s.last_scan_at ? (
                      <span title={new Date(s.last_scan_at).toLocaleString()}>
                        scanned {ago(s.last_scan_at)}
                      </span>
                    ) : (
                      "not scanned yet"
                    )}
                  </div>
                  {s.last_error && <div className="text-xs text-error">{s.last_error}</div>}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="kb-source-scan"
                  disabled={action.pending}
                  onClick={async () => {
                    const scan = await action.run(() => api.kb.scanSource(s.id));
                    if (scan) setResult(scanSummary(scan));
                    await invalidate();
                  }}
                >
                  <FolderSync size={14} />
                  Scan now
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  title={`Stop syncing ${s.root_path}`}
                  data-testid="kb-source-remove"
                  onClick={() => setRemoving(s)}
                >
                  Stop syncing
                </Button>
              </li>
            ))}
          </ul>
        )}
        {result && (
          <p role="status" data-testid="kb-source-result" className="text-outline">
            {result}
          </p>
        )}
        {adding ? (
          <form onSubmit={add} className="min-w-0 space-y-3" data-testid="kb-source-form">
            <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
              <Field label="Folder path" hint={pathHint()}>
                <div className="flex min-w-0 gap-2">
                  <Input
                    aria-label="Folder path"
                    data-testid="kb-source-path-input"
                    value={root}
                    onChange={(e) => setRoot(e.target.value)}
                    className="min-w-0 font-mono text-sm"
                    autoFocus
                  />
                  <Button
                    type="button"
                    variant="outline"
                    data-testid="kb-source-choose-folder"
                    onClick={chooseFolder}
                    disabled={choosing}
                    className="shrink-0"
                  >
                    <FolderOpen size={14} />
                    {choosing ? "Choosing…" : "Choose folder"}
                  </Button>
                </div>
              </Field>
              <Field label="File pattern" hint="e.g. *.md, **/*.md">
                <Input
                  aria-label="File pattern"
                  data-testid="kb-source-pattern-input"
                  value={pattern}
                  onChange={(e) => setPattern(e.target.value)}
                  className="font-mono text-sm"
                />
              </Field>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                size="sm"
                variant="outline"
                data-testid="kb-source-add"
                disabled={!root.trim() || action.pending}
              >
                Add folder
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                data-testid="kb-source-cancel"
                onClick={closeForm}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          list.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="-ml-2"
              data-testid="kb-folders-add-another"
              onClick={() => setAdding(true)}
            >
              <Plus size={14} />
              Add another folder
            </Button>
          )
        )}
        <ErrorLine error={action.error} />
      </div>
      <ConfirmDialog
        open={removing !== null}
        title="Stop syncing folder"
        description={removing ? stopSyncDescription(removing) : ""}
        confirmLabel="Stop syncing"
        variant="warning"
        isPending={action.pending}
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          const source = removing;
          setRemoving(null);
          if (source) await action.run(() => api.kb.removeSource(source.id));
          await invalidate();
        }}
      />
    </KbSetupRow>
  );
}
