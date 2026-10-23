import {
  KB_CALL_SOURCES,
  KB_DIGEST_DEFAULT_CRON,
  type KbCallSource,
  type KbDigest,
  type KbDigestSchedule,
  type KbDocument,
  type KnowledgeBase,
} from "@orc/core/kb";
import { useQueryClient } from "@tanstack/react-query";
import { FileText, Trash2, Upload, X } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import { BackendPicker, USE_DEFAULT_BACKEND } from "@/components/BackendPicker";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { cronLabel, cronProblem, WEEKDAYS } from "@/components/kb/KbDigest";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { TagInput } from "@/components/TagInput";
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
import { useBackends } from "@/hooks/useBackends";
import {
  KB_DIGEST_KEY,
  KB_KEY,
  useInvalidateKb,
  useKbDigestTemplate,
  useKbDocuments,
  useKbParsers,
} from "@/hooks/useKnowledge";
import { useProjects } from "@/hooks/useProjects";
import { formatBytes } from "@/lib/utils";

const GLOBAL = "__global__";
const AUTO_PARSER = "__auto__";

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

/** Runs one request at a time and keeps its error for the dialog. */
export function useAction() {
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

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm text-muted-foreground">{label}</Label>
      {children}
      {hint && <p className="text-xs text-outline">{hint}</p>}
    </div>
  );
}

export function ErrorLine({ error }: { error: string | null }) {
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
  size,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  wide?: boolean;
  /** xl fits a document's worth of text. */
  size?: "xl";
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className={`bg-surface border-outline-variant ${size === "xl" ? "w-[calc(100%_-_1rem)] max-w-4xl" : wide ? "max-w-3xl" : "max-w-md"}`}
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

export const SOURCE_LABELS: Record<KbCallSource, string> = {
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
            placeholder="e.g. Runbooks"
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
  const projects = useProjects();
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
        <div className="space-y-1 text-sm">
          <div className="font-medium">Belongs to</div>
          <p className="text-outline" data-testid="kb-settings-owner">
            {kb.project_id === null
              ? "Global, visible in every project"
              : `${projects.data?.find((p) => p.id === kb.project_id)?.name ?? "A project"}, visible in that project`}
            . Set when the knowledge base is created.
          </p>
        </div>
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

/** A pasted document's own top heading names it when no title is typed. */
function firstHeading(content: string): string {
  return content.match(/^#\s+(.+?)\s*#*\s*$/m)?.[1]?.trim() ?? "";
}

/** Files read as text and edited here; every other format is converted by the server. */
const TEXT_FILE = /\.(md|markdown|txt)$/i;

export function NewDocumentDialog({
  kb,
  initialFile,
  onClose,
  onCreated,
  onUploadMany,
}: {
  kb: KnowledgeBase;
  /** A file dropped on the page, shown here to review before it is added. */
  initialFile?: File;
  onClose: () => void;
  /** `written` is true when the document was created with content rather than empty. */
  onCreated: (doc: KbDocument, written: boolean) => void;
  /** Several files chosen at once skip the review and upload together. */
  onUploadMany: (files: File[]) => void;
}) {
  const invalidate = useInvalidateKb();
  const action = useAction();
  const listing = useKbDocuments(kb.id);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [path, setPath] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  // A file the server converts; its text is not editable before it is added.
  const [file, setFile] = useState<File | null>(null);
  const [reading, setReading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const heading = file ? "" : firstHeading(content);
  const name = title.trim() || heading;
  const suggested = file ? file.name : slugFile(name);
  const written = file !== null || content.trim() !== "";

  async function choose(chosen: File) {
    const stem = chosen.name.replace(/\.[^.]+$/, "");
    if (!TEXT_FILE.test(chosen.name)) {
      setFile(chosen);
      setTitle(stem);
      setPath("");
      return;
    }
    setReading(true);
    const text = await action.run(() => chosen.text());
    setReading(false);
    if (text === undefined) return;
    setFile(null);
    setContent(text);
    setTitle(firstHeading(text) || stem);
    setPath(/\.txt$/i.test(chosen.name) ? slugFile(stem) : chosen.name);
  }

  function pick(files: FileList | null) {
    const list = [...(files ?? [])];
    if (list.length > 1) onUploadMany(list);
    else if (list[0]) void choose(list[0]);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: a dropped file is read once, when the dialog opens
  useEffect(() => {
    if (initialFile) void choose(initialFile);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const doc = await action.run(() =>
      file
        ? api.kb.upload(kb.id, {
            file,
            title: name,
            path: path.trim() || undefined,
            labels,
          })
        : api.kb.createDocument(kb.id, {
            title: name,
            path: path.trim() || suggested,
            labels,
            content: written ? content : `# ${name}\n\n`,
          }),
    );
    if (!doc) return;
    await invalidate();
    onCreated(doc, written);
  }
  return (
    <Shell open onClose={onClose} title={`New document in ${kb.name}`} size="xl">
      <form onSubmit={submit} className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm text-outline">
          <span>Write or paste below, or start from a file.</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="kb-doc-choose-file"
            disabled={reading || action.pending}
            onClick={() => fileInput.current?.click()}
          >
            <Upload size={16} />
            {reading ? "Reading…" : "Upload file"}
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            data-testid="kb-doc-file-input"
            onChange={(e) => {
              pick(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
        <Field
          label="Title"
          hint={heading && !title.trim() ? "Taken from the first heading." : undefined}
        >
          <Input
            aria-label="Title"
            data-testid="kb-doc-title-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={heading || "e.g. Deploy runbook"}
            autoFocus
          />
        </Field>
        {file ? (
          <Field
            label="File"
            hint="Converted to searchable text after it is added. The original file is kept."
          >
            <div
              data-testid="kb-doc-file"
              className="flex items-center gap-3 rounded-md border border-surface-highest bg-surface p-3"
            >
              <FileText size={20} className="shrink-0 text-outline" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-sm" title={file.name}>
                {file.name}
              </span>
              <span className="shrink-0 text-xs text-outline">{formatBytes(file.size)}</span>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Remove ${file.name}`}
                data-testid="kb-doc-file-remove"
                onClick={() => {
                  setFile(null);
                  setTitle("");
                }}
              >
                <X size={16} />
              </Button>
            </div>
          </Field>
        ) : (
          <Field label="Content" hint="Markdown. Leave empty to start writing in the editor.">
            <MarkdownEditor
              path={path.trim() || suggested}
              value={content}
              onChange={setContent}
              testId="kb-doc-content-input"
              label="Content"
              placeholder="Write or paste Markdown"
              initialMode="edit"
              height="45vh"
            />
          </Field>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Labels" hint="Enter, comma or space adds a label.">
            <TagInput
              aria-label="Labels"
              data-testid="kb-doc-labels-input"
              value={labels}
              onChange={setLabels}
              suggestions={listing.data?.labels.map((l) => l.label)}
            />
          </Field>
          <Field label="Path" hint="Optional. Folders come from the path, e.g. guides/setup.md.">
            <Input
              aria-label="Path"
              data-testid="kb-doc-path-input"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={suggested}
              className="font-mono text-sm"
            />
          </Field>
        </div>
        <ErrorLine error={action.error} />
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            data-testid="kb-doc-create-submit"
            disabled={!name || action.pending}
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
  linkedFrom,
  onClose,
  onSaved,
}: {
  doc: KbDocument;
  /** Documents linking here; links name a title or path, so renaming either breaks them. */
  linkedFrom: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const invalidate = useInvalidateKb();
  const action = useAction();
  const [title, setTitle] = useState(doc.title);
  const [path, setPath] = useState(doc.path);
  const listing = useKbDocuments(doc.kb_id);
  const [labels, setLabels] = useState(doc.labels);
  const [description, setDescription] = useState(doc.description);
  const renamed = title.trim() !== doc.title || path.trim() !== doc.path;
  async function submit(e: FormEvent) {
    e.preventDefault();
    const saved = await action.run(() =>
      api.kb.updateDocument(doc.id, {
        expected_revision: doc.revision,
        title: title.trim(),
        path: path.trim(),
        labels,
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
        <Field label="Labels" hint="Enter, comma or space adds a label.">
          <TagInput
            aria-label="Labels"
            data-testid="kb-doc-labels-input"
            value={labels}
            onChange={setLabels}
            suggestions={listing.data?.labels.map((l) => l.label)}
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
        {renamed && linkedFrom > 0 && (
          <p role="status" className="text-sm text-warning" data-testid="kb-rename-warning">
            {linkedFrom === 1 ? "1 document links" : `${linkedFrom} documents link`} to this
            document. Links that use the old title or path will show as missing.
          </p>
        )}
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

type Plan = "daily" | "weekly" | "custom" | "manual";

const PLAN_LABELS: Record<Plan, string> = {
  daily: "Every day",
  weekly: "Once a week",
  custom: "Custom cron",
  manual: "Manual only",
};

type ScheduleForm = { plan: Plan; time: string; day: string; cron: string };

/** Opens a saved schedule as the simplest preset that writes the same cron. */
function scheduleForm(schedule: KbDigestSchedule): ScheduleForm {
  const cron = schedule.type === "cron" ? schedule.cron : KB_DIGEST_DEFAULT_CRON;
  const form: ScheduleForm = { plan: "custom", time: "03:00", day: "1", cron };
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6])$/.exec(cron.trim().split(/\s+/).join(" "));
  const [m, h] = [Number(match?.[1]), Number(match?.[2])];
  const time =
    match && m <= 59 && h <= 23
      ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
      : null;
  if (schedule.type === "manual") return { ...form, plan: "manual", time: time ?? form.time };
  if (!match?.[3] || !time) return form;
  return match[3] === "*"
    ? { ...form, plan: "daily", time }
    : { ...form, plan: "weekly", time, day: match[3] };
}

/** The cron a form writes; null for a manual digest. */
function formCron({ plan, time, day, cron }: ScheduleForm): string | null {
  if (plan === "manual") return null;
  if (plan === "custom") return cron.trim();
  const [h, m] = time.split(":").map(Number);
  return `${m} ${h} * * ${plan === "weekly" ? day : "*"}`;
}

function formProblem(form: ScheduleForm): string | null {
  if (form.plan === "manual") return null;
  if (form.plan === "custom") return cronProblem(form.cron);
  return /^\d{2}:\d{2}$/.test(form.time) ? null : "Pick a time.";
}

/** "Runs daily at 03:00", "Runs Mondays at 04:00", or the cron itself when it has no plain words. */
function runsLabel(cron: string): string {
  const label = cronLabel(cron);
  if (label === cron) return "Runs on this cron schedule";
  return WEEKDAYS.some((d) => label.startsWith(d))
    ? `Runs ${label}`
    : `Runs ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

function ScheduleFields({
  value,
  onChange,
}: {
  value: ScheduleForm;
  onChange: (v: ScheduleForm) => void;
}) {
  const cron = formCron(value);
  const problem = formProblem(value);
  const set = (patch: Partial<ScheduleForm>) => onChange({ ...value, ...patch });
  return (
    <fieldset className="space-y-3 rounded-md border border-outline-variant p-3">
      <legend className="px-1 text-sm text-muted-foreground">When it runs</legend>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Schedule">
          <Select
            value={value.plan}
            onValueChange={(v) =>
              // Switching to custom starts from the preset's cron, so it can be tweaked.
              set({ plan: v as Plan, ...(v === "custom" && cron ? { cron } : {}) })
            }
          >
            <SelectTrigger aria-label="Schedule" data-testid="kb-digest-schedule">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(PLAN_LABELS) as Plan[]).map((p) => (
                <SelectItem key={p} value={p}>
                  {PLAN_LABELS[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {value.plan === "weekly" && (
          <Field label="Day">
            <Select value={value.day} onValueChange={(day) => set({ day })}>
              <SelectTrigger aria-label="Day" data-testid="kb-digest-day">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WEEKDAYS.map((d, i) => (
                  <SelectItem key={d} value={String(i)}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
        {(value.plan === "daily" || value.plan === "weekly") && (
          <Field label="Time">
            <Input
              type="time"
              aria-label="Time"
              data-testid="kb-digest-time"
              value={value.time}
              onChange={(e) => set({ time: e.target.value })}
            />
          </Field>
        )}
        {value.plan === "custom" && (
          <div className="sm:col-span-2">
            <Field label="Cron expression" hint="minute hour day month weekday, e.g. 0 */6 * * *">
              <Input
                aria-label="Cron expression"
                aria-invalid={problem !== null}
                data-testid="kb-digest-cron"
                value={value.cron}
                onChange={(e) => set({ cron: e.target.value })}
                className="font-mono"
                autoComplete="off"
              />
            </Field>
          </div>
        )}
      </div>
      <p
        aria-live="polite"
        data-testid="kb-digest-schedule-preview"
        data-valid={problem === null}
        className={`text-sm ${problem ? "text-error" : "text-outline"}`}
      >
        {problem ? (
          problem
        ) : cron ? (
          <>
            {runsLabel(cron)} <span className="font-mono text-xs">({cron})</span>, in the ORC
            server's time zone.
          </>
        ) : (
          "Runs only when you start it."
        )}
      </p>
    </fieldset>
  );
}

export function DigestDialog({
  kb,
  digest,
  onClose,
  onRemove,
}: {
  kb: KnowledgeBase;
  digest: KbDigest | null;
  onClose: () => void;
  onRemove?: () => void;
}) {
  const invalidate = useInvalidateKb();
  const action = useAction();
  const backends = useBackends();
  const template = useKbDigestTemplate(!digest);
  const [instructions, setInstructions] = useState<string | null>(digest?.instructions ?? null);
  const [backend, setBackend] = useState(digest?.backend ?? USE_DEFAULT_BACKEND);
  const [schedule, setSchedule] = useState(() =>
    scheduleForm(digest?.schedule ?? { type: "cron", cron: KB_DIGEST_DEFAULT_CRON }),
  );
  useEffect(() => {
    if (instructions === null && template.data) setInstructions(template.data.instructions);
  }, [instructions, template.data]);

  const problem = formProblem(schedule);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (problem) return action.setError(problem);
    const chosen = backend === USE_DEFAULT_BACKEND ? backends.data?.default_backend : backend;
    const cron = formCron(schedule);
    const saved = await action.run(() =>
      api.kb.setDigest(kb.id, {
        instructions: instructions?.trim() ?? "",
        ...(chosen ? { backend: chosen } : {}),
        schedule: cron ? { type: "cron", cron } : { type: "manual" },
      }),
    );
    if (!saved) return;
    await invalidate();
    onClose();
  }
  const ready = instructions !== null;
  return (
    <Shell open onClose={onClose} title={digest ? "Digest settings" : "Set up a digest"} wide>
      <form onSubmit={submit} className="min-w-0 space-y-4">
        {!kb.editable_by.includes("mcp") && (
          <p className="text-sm text-warning" data-testid="kb-digest-mcp-hint">
            The digest writes through MCP. Allow Agents (MCP) in this knowledge base's settings
            first.
          </p>
        )}
        <ScheduleFields value={schedule} onChange={setSchedule} />
        <BackendPicker value={backend} onChange={setBackend} testId="kb-digest-backend" />
        <Field label="Instructions">
          {ready ? (
            <MarkdownEditor
              path="digest.md"
              value={instructions}
              onChange={setInstructions}
              testId="kb-digest-instructions"
              label="Instructions"
              initialMode="edit"
              height={320}
            />
          ) : template.error ? (
            <p role="alert" className="text-sm text-error">
              {message(template.error)}
            </p>
          ) : (
            <p role="status" className="text-sm text-outline">
              Loading template…
            </p>
          )}
        </Field>
        <ErrorLine error={action.error} />
        <DialogFooter className="gap-2 sm:justify-between">
          {digest && onRemove ? (
            <Button
              type="button"
              variant="ghost"
              className="text-error"
              data-testid="kb-digest-remove"
              onClick={onRemove}
            >
              <Trash2 size={14} />
              Remove digest
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              data-testid="kb-digest-save"
              disabled={!ready || !instructions?.trim() || problem !== null || action.pending}
            >
              {action.pending ? "Saving…" : "Save"}
            </Button>
          </div>
        </DialogFooter>
      </form>
    </Shell>
  );
}

export function RemoveDigestDialog({ kb, onClose }: { kb: KnowledgeBase; onClose: () => void }) {
  const queryClient = useQueryClient();
  const action = useAction();
  async function remove() {
    // Only an agent (MCP) must name the knowledge base to confirm; this dialog is the UI's confirm.
    const done = await action.run(() => api.kb.removeDigest(kb.id, kb.name));
    if (done === undefined) return;
    queryClient.setQueryData([KB_DIGEST_KEY, kb.id], { digest: null });
    await queryClient.invalidateQueries({ queryKey: [KB_KEY] });
    onClose();
  }
  return (
    <Shell open onClose={onClose} title="Remove digest?">
      <div className="space-y-4">
        <p className="text-sm text-outline">
          Documents and comments stay. The digest's instructions, schedule, job and run history are
          removed.
        </p>
        <ErrorLine error={action.error} />
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            data-testid="kb-digest-remove-confirm"
            onClick={remove}
            disabled={action.pending}
            autoFocus
          >
            {action.pending ? "Removing…" : "Remove digest"}
          </Button>
        </DialogFooter>
      </div>
    </Shell>
  );
}
