import {
  KB_CALL_SOURCES,
  type KbCallSource,
  type KbDocument,
  type KnowledgeBase,
} from "@orc/core/kb";
import { FolderSync, Trash2 } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { api } from "@/api/client";
import { ConfirmDialog } from "@/components/ConfirmDialog";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useInvalidateKb, useKbParsers, useKbSources } from "@/hooks/useKnowledge";
import { useProjects } from "@/hooks/useProjects";

const GLOBAL = "__global__";
const AUTO_PARSER = "__auto__";

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

/** Runs one request at a time and keeps its error for the dialog. */
function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    setPending(true);
    setError(null);
    try {
      return await action();
    } catch (cause) {
      setError(message(cause));
      return undefined;
    } finally {
      setPending(false);
    }
  }
  return { pending, error, run, setError };
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm text-muted-foreground">{label}</Label>
      {children}
      {hint && <p className="text-xs text-outline">{hint}</p>}
    </div>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" data-testid="kb-dialog-error" className="text-sm text-error">
      {error}
    </p>
  );
}

function Shell({
  open,
  onClose,
  title,
  wide,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className={`bg-surface border-outline-variant ${wide ? "max-w-3xl" : "max-w-md"} max-h-[90vh] overflow-y-auto`}
      >
        <DialogHeader>
          <DialogTitle className="text-base text-on-surface">{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

function ParserSelect({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const parsers = useKbParsers();
  return (
    <Select
      value={value ?? AUTO_PARSER}
      onValueChange={(v) => onChange(v === AUTO_PARSER ? null : v)}
    >
      <SelectTrigger aria-label="Parser" data-testid="kb-parser-select">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={AUTO_PARSER}>Workspace default</SelectItem>
        {(parsers.data?.parsers ?? []).map((p) => (
          <SelectItem key={p.id} value={p.id} disabled={!p.installed}>
            {p.label}
            {p.installed ? "" : " (not installed)"}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const SOURCE_LABELS: Record<KbCallSource, string> = {
  ui: "Web UI",
  cli: "CLI",
  api: "REST API",
  mcp: "Agents (MCP)",
};

/** Which call sources may change documents. Reading and search are open to every source. */
function EditableByFields({
  value,
  onChange,
}: {
  value: KbCallSource[];
  onChange: (v: KbCallSource[]) => void;
}) {
  return (
    <fieldset className="space-y-2 rounded-md border border-outline-variant p-3">
      <legend className="px-1 text-sm text-muted-foreground">Who can change documents</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {KB_CALL_SOURCES.map((source) => (
          <label key={source} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid={`kb-editable-${source}`}
              checked={value.includes(source)}
              onChange={(e) =>
                onChange(
                  KB_CALL_SOURCES.filter((s) =>
                    s === source ? e.target.checked : value.includes(s),
                  ),
                )
              }
            />
            {SOURCE_LABELS[source]}
          </label>
        ))}
      </div>
      <p className="text-xs text-outline">
        Every source can read and search. Knowledge base settings change only from the UI, CLI or
        API.
      </p>
    </fieldset>
  );
}

export function CreateKbDialog({
  open,
  projectId,
  onClose,
  onCreated,
}: {
  open: boolean;
  projectId: string | undefined;
  onClose: () => void;
  onCreated: (kb: KnowledgeBase) => void;
}) {
  const projects = useProjects();
  const invalidate = useInvalidateKb();
  const action = useAction();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [owner, setOwner] = useState(projectId ?? GLOBAL);
  const [editableBy, setEditableBy] = useState<KbCallSource[]>([...KB_CALL_SOURCES]);
  const [parser, setParser] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const kb = await action.run(() =>
      api.kb.create({
        name: name.trim(),
        description: description.trim(),
        project_id: owner === GLOBAL ? null : owner,
        editable_by: editableBy,
        parser,
      }),
    );
    if (!kb) return;
    await invalidate();
    onCreated(kb);
  }
  return (
    <Shell open={open} onClose={onClose} title="New knowledge base">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name">
          <Input
            aria-label="Name"
            data-testid="kb-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Runbooks"
            autoFocus
          />
        </Field>
        <Field label="Description">
          <Textarea
            aria-label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
          />
        </Field>
        <Field
          label="Belongs to"
          hint="Project knowledge bases are visible in that project; global ones in every project."
        >
          <Select value={owner} onValueChange={setOwner}>
            <SelectTrigger aria-label="Belongs to" data-testid="kb-owner-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={GLOBAL}>Global (all projects)</SelectItem>
              {(projects.data ?? []).map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <EditableByFields value={editableBy} onChange={setEditableBy} />
        <Field label="Parser for uploads">
          <ParserSelect value={parser} onChange={setParser} />
        </Field>
        <ErrorLine error={action.error} />
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            data-testid="kb-create-submit"
            disabled={!name.trim() || action.pending}
          >
            {action.pending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </form>
    </Shell>
  );
}

export function KbSettingsDialog({
  kb,
  onClose,
  onDeleted,
}: {
  kb: KnowledgeBase;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const invalidate = useInvalidateKb();
  const action = useAction();
  const [name, setName] = useState(kb.name);
  const [description, setDescription] = useState(kb.description);
  const [editableBy, setEditableBy] = useState(kb.editable_by);
  const [parser, setParser] = useState(kb.parser);
  const [confirming, setConfirming] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const saved = await action.run(() =>
      api.kb.update(kb.id, {
        name: name.trim(),
        description: description.trim(),
        editable_by: editableBy,
        parser,
      }),
    );
    if (!saved) return;
    await invalidate();
    onClose();
  }
  return (
    <Shell open onClose={onClose} title="Knowledge base settings">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name">
          <Input
            aria-label="Name"
            data-testid="kb-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Description">
          <Textarea
            aria-label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
          />
        </Field>
        <EditableByFields value={editableBy} onChange={setEditableBy} />
        <Field label="Parser for uploads" hint="Applies to new uploads and reparses.">
          <ParserSelect value={parser} onChange={setParser} />
        </Field>
        <ErrorLine error={action.error} />
        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            className="text-error"
            data-testid="kb-delete"
            onClick={() => setConfirming(true)}
          >
            <Trash2 size={14} />
            Delete
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              data-testid="kb-settings-save"
              disabled={!name.trim() || action.pending}
            >
              Save
            </Button>
          </div>
        </DialogFooter>
      </form>
      <ConfirmDialog
        open={confirming}
        title="Delete knowledge base"
        description={`Delete "${kb.name}" with its ${kb.document_count} documents, revisions and uploaded files? Registered folders on disk are not touched.`}
        isPending={action.pending}
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          const done = await action.run(() => api.kb.remove(kb.id));
          setConfirming(false);
          if (done === undefined) return;
          await invalidate();
          onDeleted();
        }}
      />
    </Shell>
  );
}

function slugFile(title: string): string {
  const base = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base || "untitled"}.md`;
}

export function parseLabels(text: string): string[] {
  return [
    ...new Set(
      text
        .split(",")
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ];
}

export function NewDocumentDialog({
  kb,
  folder,
  onClose,
  onCreated,
}: {
  kb: KnowledgeBase;
  folder: string;
  onClose: () => void;
  onCreated: (doc: KbDocument) => void;
}) {
  const invalidate = useInvalidateKb();
  const action = useAction();
  const [title, setTitle] = useState("");
  const [path, setPath] = useState("");
  const [labels, setLabels] = useState("");
  const suggested = `${folder ? `${folder}/` : ""}${slugFile(title)}`;
  async function submit(e: FormEvent) {
    e.preventDefault();
    const doc = await action.run(() =>
      api.kb.createDocument(kb.id, {
        title: title.trim(),
        path: path.trim() || suggested,
        labels: parseLabels(labels),
        content: `# ${title.trim()}\n\n`,
      }),
    );
    if (!doc) return;
    await invalidate();
    onCreated(doc);
  }
  return (
    <Shell open onClose={onClose} title={`New document in ${kb.name}`}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Title">
          <Input
            aria-label="Title"
            data-testid="kb-doc-title-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
        </Field>
        <Field label="Path" hint="Folders come from the path, for example guides/setup.md.">
          <Input
            aria-label="Path"
            data-testid="kb-doc-path-input"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={suggested}
            className="font-mono text-sm"
          />
        </Field>
        <Field label="Labels" hint="Comma separated.">
          <Input
            aria-label="Labels"
            data-testid="kb-doc-labels-input"
            value={labels}
            onChange={(e) => setLabels(e.target.value)}
          />
        </Field>
        <ErrorLine error={action.error} />
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            data-testid="kb-doc-create-submit"
            disabled={!title.trim() || action.pending}
          >
            Create
          </Button>
        </DialogFooter>
      </form>
    </Shell>
  );
}

export function DocumentPropertiesDialog({
  doc,
  onClose,
  onSaved,
}: {
  doc: KbDocument;
  onClose: () => void;
  onSaved: () => void;
}) {
  const invalidate = useInvalidateKb();
  const action = useAction();
  const [title, setTitle] = useState(doc.title);
  const [path, setPath] = useState(doc.path);
  const [labels, setLabels] = useState(doc.labels.join(", "));
  const [description, setDescription] = useState(doc.description);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const saved = await action.run(() =>
      api.kb.updateDocument(doc.id, {
        expected_revision: doc.revision,
        title: title.trim(),
        path: path.trim(),
        labels: parseLabels(labels),
        description: description.trim(),
      }),
    );
    if (!saved) return;
    await invalidate();
    onSaved();
  }
  return (
    <Shell open onClose={onClose} title="Document properties">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Title">
          <Input
            aria-label="Title"
            data-testid="kb-doc-title-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field label="Path">
          <Input
            aria-label="Path"
            data-testid="kb-doc-path-input"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            className="font-mono text-sm"
          />
        </Field>
        <Field label="Labels" hint="Comma separated.">
          <Input
            aria-label="Labels"
            data-testid="kb-doc-labels-input"
            value={labels}
            onChange={(e) => setLabels(e.target.value)}
          />
        </Field>
        <Field label="Description">
          <Textarea
            aria-label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
          />
        </Field>
        <ErrorLine error={action.error} />
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            data-testid="kb-doc-properties-save"
            disabled={!title.trim() || action.pending}
          >
            Save
          </Button>
        </DialogFooter>
      </form>
    </Shell>
  );
}

export function SourcesDialog({ kb, onClose }: { kb: KnowledgeBase; onClose: () => void }) {
  const sources = useKbSources(kb.id);
  const invalidate = useInvalidateKb();
  const action = useAction();
  const [root, setRoot] = useState("");
  const [pattern, setPattern] = useState("**/*.md");
  const [result, setResult] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  function summary(scan: { added: number; updated: number; missing: number; errors: string[] }) {
    return `${scan.added} added · ${scan.updated} updated · ${scan.missing} missing${scan.errors.length ? ` · ${scan.errors.length} errors: ${scan.errors.slice(0, 3).join("; ")}` : ""}`;
  }
  async function add(e: FormEvent) {
    e.preventDefault();
    const added = await action.run(() =>
      api.kb.addSource(kb.id, { root_path: root.trim(), pattern: pattern.trim() || "**/*.md" }),
    );
    if (!added) return;
    setRoot("");
    setResult(summary(added.scan));
    await invalidate();
  }
  return (
    <Shell open onClose={onClose} title="Registered folders" wide>
      <p className="text-sm text-outline">
        Files are copied into ORC and the folder is never written. A copy follows its file on each
        scan until you edit it here; after that it stays as edited. A file deleted from the folder
        keeps its copy.
      </p>
      <div className="space-y-2" data-testid="kb-sources-list">
        {sources.isLoading && <p className="text-sm text-outline">Loading…</p>}
        {sources.data?.length === 0 && (
          <p className="text-sm text-outline">No folders registered.</p>
        )}
        {sources.data?.map((s) => (
          <div
            key={s.id}
            data-testid="kb-source-row"
            className="flex flex-wrap items-center gap-2 rounded-md border border-outline-variant p-3"
          >
            <div className="min-w-0 flex-1">
              <div className="break-all font-mono text-sm">{s.root_path}</div>
              <div className="text-xs text-outline">
                {s.pattern} · {s.document_count} documents ·{" "}
                {s.last_scan_at
                  ? `scanned ${new Date(s.last_scan_at).toLocaleString()}`
                  : "never scanned"}
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
                if (scan) setResult(summary(scan));
                await invalidate();
              }}
            >
              <FolderSync size={14} />
              Rescan
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-error"
              data-testid="kb-source-remove"
              onClick={() => setRemoving(s.id)}
            >
              <Trash2 size={14} />
            </Button>
          </div>
        ))}
      </div>
      {result && (
        <p role="status" data-testid="kb-source-result" className="text-sm text-outline">
          {result}
        </p>
      )}
      <form onSubmit={add} className="grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
        <Field label="Folder path">
          <Input
            aria-label="Folder path"
            data-testid="kb-source-path-input"
            value={root}
            onChange={(e) => setRoot(e.target.value)}
            placeholder="/home/me/notes"
            className="font-mono text-sm"
          />
        </Field>
        <Field label="Pattern">
          <Input
            aria-label="Pattern"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            className="font-mono text-sm"
          />
        </Field>
        <Button type="submit" data-testid="kb-source-add" disabled={!root.trim() || action.pending}>
          Add folder
        </Button>
      </form>
      <ErrorLine error={action.error} />
      <ConfirmDialog
        open={removing !== null}
        title="Remove folder"
        description="Its copies, including edited ones, leave this knowledge base. The folder on disk is not touched."
        confirmLabel="Remove"
        isPending={action.pending}
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          const id = removing;
          setRemoving(null);
          if (id) await action.run(() => api.kb.removeSource(id));
          await invalidate();
        }}
      />
    </Shell>
  );
}
