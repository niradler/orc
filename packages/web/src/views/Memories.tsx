import { Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  MEMORY_CONTENT_MAX,
  MEMORY_DESCRIPTION_MAX,
  MEMORY_PRIORITY_MAX,
  type Memory,
  type MemoryListItem,
  type MemorySnapshot,
  type MemorySort,
} from "@/api/client";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DetailField } from "@/components/DetailField";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
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
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ViewHeader } from "@/components/ViewHeader";
import {
  useCreateMemory,
  useDeleteMemory,
  useMemories,
  useMemory,
  useMemoryHistory,
  useRevertMemory,
  useUpdateMemory,
} from "@/hooks/useMemories";
import { useProjects } from "@/hooks/useProjects";
import { MEMORIES_PATH, memoryPath } from "@/lib/memory-routes";
import { useViewParam } from "@/lib/view-params";

const ALL_PROJECTS = "all";
const LIST_LIMIT = 200;

const SORTS: Array<{ value: MemorySort; label: string }> = [
  { value: "reads", label: "Most read" },
  { value: "recent", label: "Recent" },
  { value: "priority", label: "Priority" },
];

/** Memory timestamps are unix seconds. */
function formatTime(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString();
}

export default function Memories({
  projectId: savedProjectId,
}: {
  projectId: string;
  /** Rendered inside the Knowledge view; the page layout is the same either way. */
  embedded?: boolean;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { memoryProject, memoryName } = useParams();
  // `?project=` scopes this view only; the saved sidebar project is the default.
  const [project, setProject] = useViewParam<string>("project", savedProjectId);
  const [query, setQuery] = useViewParam<string>("memoryQuery", "");
  const [sort, setSort] = useViewParam<MemorySort>(
    "memorySort",
    "reads",
    SORTS.map((s) => s.value),
  );
  const [searchInput, setSearchInput] = useState(query);
  useEffect(() => setSearchInput(query), [query]);
  const [editing, setEditing] = useState<Memory | "new" | null>(null);
  const [deleting, setDeleting] = useState<Memory | null>(null);
  const { data: projects } = useProjects({ status: "active" });
  const deleteMemory = useDeleteMemory();

  // Memories always belong to a project, so "unassigned" has none to show.
  const unassigned = project === "unassigned";
  const allProjects = project === ALL_PROJECTS;
  const list = useMemories(
    {
      project_id: allProjects ? undefined : project,
      q: query || undefined,
      sort,
      limit: LIST_LIMIT,
    },
    { enabled: !unassigned },
  );
  const memories = list.data?.memories ?? [];
  const projectName = (id: string) => projects?.find((p) => p.id === id)?.name ?? id;
  const selectedItem = memories.find(
    (m) => m.project_id === memoryProject && m.name === memoryName,
  );

  const openDetail = (item: { project_id: string; name: string }) =>
    navigate(`${memoryPath(item.project_id, item.name)}${location.search}`);
  const closeDetail = () => navigate(`${MEMORIES_PATH}${location.search}`);

  return (
    <div>
      <ViewHeader
        title="Memories"
        meta={
          list.data
            ? `${list.data.total} ${list.data.total === 1 ? "memory" : "memories"}`
            : undefined
        }
        action={
          <Button
            data-testid="new-memory-button"
            size="sm"
            onClick={() => setEditing("new")}
            className="font-label text-sm"
          >
            <Plus size={12} className="mr-1" /> New memory
          </Button>
        }
      />
      <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
        Short project facts agents load next session: ports, conventions, gotchas, decisions. Longer
        procedures belong in a skill.
      </p>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Select value={project} onValueChange={(value) => setProject(value)}>
          <SelectTrigger
            aria-label="Project"
            data-testid="memory-project-filter"
            className="h-9 w-48 bg-background text-on-surface font-body text-sm"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-surface border-outline-variant">
            <SelectItem value={ALL_PROJECTS} className="font-body text-sm">
              All projects
            </SelectItem>
            {unassigned && (
              <SelectItem value="unassigned" className="font-body text-sm">
                Unassigned
              </SelectItem>
            )}
            {projects?.map((p) => (
              <SelectItem
                key={p.id}
                value={p.id}
                data-testid={`memory-project-option-${p.id}`}
                className="font-body text-sm"
              >
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex shrink-0 flex-wrap gap-1.5">
          {SORTS.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => setSort(s.value)}
              data-testid={`memory-sort-${s.value}`}
              aria-pressed={sort === s.value}
              className={`font-label text-sm px-3 py-1.5 border transition-colors ${
                sort === s.value
                  ? "bg-surface-highest text-on-surface border-transparent"
                  : "bg-transparent border-transparent text-muted-foreground hover:bg-surface-low hover:text-on-surface"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="relative min-w-[160px] flex-1">
          <Search
            size={12}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label="Search memories"
            data-testid="memory-search-input"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setQuery(e.currentTarget.value)}
            placeholder="Search memories..."
            className="pl-8 bg-background text-on-surface font-body text-sm placeholder:text-muted-foreground"
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setQuery(searchInput)}
          className="font-label text-sm"
        >
          Search
        </Button>
      </div>

      {unassigned ? (
        <EmptyState message="Memories belong to a project. Choose a project to see its memories." />
      ) : list.error ? (
        <ErrorState message={list.error.message} onRetry={() => void list.refetch()} />
      ) : list.isLoading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <Skeleton key={i} className="h-10 w-full bg-surface-highest" />
          ))}
        </div>
      ) : memories.length === 0 ? (
        <EmptyState message={query ? "No memories match your search" : "No memories yet"} />
      ) : (
        <div className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-outline-variant hover:bg-transparent">
                <TableHead className="font-label text-sm text-muted-foreground">Name</TableHead>
                <TableHead className="font-label text-sm text-muted-foreground">
                  Description
                </TableHead>
                {allProjects && (
                  <TableHead className="font-label text-sm text-muted-foreground">
                    Project
                  </TableHead>
                )}
                <TableHead className="font-label text-sm text-muted-foreground w-20">
                  Priority
                </TableHead>
                <TableHead className="font-label text-sm text-muted-foreground w-16">
                  Reads
                </TableHead>
                <TableHead className="font-label text-sm text-muted-foreground w-44">
                  Updated
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {memories.map((memory) => (
                <TableRow
                  key={memory.key}
                  data-testid="memory-row"
                  data-memory-name={memory.name}
                  data-memory-project={memory.project_id}
                  className="border-b border-outline-variant/50 hover:bg-surface-low cursor-pointer"
                  onClick={() => openDetail(memory)}
                >
                  <TableCell className="font-body text-sm font-medium text-on-surface">
                    <button
                      type="button"
                      className="min-h-11 text-left hover:text-primary"
                      onClick={(event) => {
                        event.stopPropagation();
                        openDetail(memory);
                      }}
                    >
                      {memory.name}
                    </button>
                  </TableCell>
                  <TableCell className="font-body text-sm text-muted-foreground max-w-md truncate">
                    {memory.description}
                  </TableCell>
                  {allProjects && (
                    <TableCell className="font-body text-sm text-muted-foreground">
                      {projectName(memory.project_id)}
                    </TableCell>
                  )}
                  <TableCell>
                    <MemoryPriority priority={memory.priority} />
                  </TableCell>
                  <TableCell
                    data-testid="memory-read-count"
                    className="font-label text-sm text-muted-foreground"
                    title={readsTitle(memory)}
                  >
                    {memory.read_count}
                  </TableCell>
                  <TableCell className="font-label text-sm text-muted-foreground">
                    {formatTime(memory.updated_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {memoryProject && memoryName && (
        <MemoryDetailSheet
          key={`${memoryProject}/${memoryName}`}
          projectId={memoryProject}
          name={memoryName}
          projectName={projectName(memoryProject)}
          listItem={selectedItem}
          onClose={closeDetail}
          onEdit={setEditing}
          onDelete={setDeleting}
        />
      )}

      {editing && (
        <MemoryFormDialog
          memory={editing === "new" ? null : editing}
          defaultProjectId={allProjects || unassigned ? "" : project}
          onClose={() => setEditing(null)}
          onCreated={(memory) => openDetail(memory)}
        />
      )}

      {deleting && (
        <ConfirmDialog
          open
          title="Delete memory"
          description={`Delete "${deleting.name}"? It can be restored from its history.`}
          confirmLabel="Delete"
          variant="destructive"
          isPending={deleteMemory.isPending}
          onConfirm={() =>
            deleteMemory.mutate(
              { projectId: deleting.project_id, name: deleting.name },
              {
                onSuccess: () => {
                  setDeleting(null);
                  closeDetail();
                },
              },
            )
          }
          onCancel={() => setDeleting(null)}
        />
      )}
      {deleteMemory.error && (
        <p role="alert" className="text-sm text-destructive mt-2">
          {deleteMemory.error.message}
        </p>
      )}
    </div>
  );
}

function readsTitle(memory: MemoryListItem): string {
  const { mcp, cli, api, ui } = memory.reads_by_source;
  const last = memory.last_read_at ? ` · last read ${formatTime(memory.last_read_at)}` : "";
  return `mcp ${mcp} · cli ${cli} · api ${api} · ui ${ui}${last}`;
}

function MemoryPriority({ priority }: { priority: number | null }) {
  return priority === null ? (
    <span data-testid="memory-priority" className="font-label text-xs text-outline">
      Unscored
    </span>
  ) : (
    <span data-testid="memory-priority" className="font-label text-xs text-primary">
      P{priority}
    </span>
  );
}

function MemoryDetailSheet({
  projectId,
  name,
  projectName,
  listItem,
  onClose,
  onEdit,
  onDelete,
}: {
  projectId: string;
  name: string;
  projectName: string;
  listItem?: MemoryListItem;
  onClose: () => void;
  onEdit: (memory: Memory) => void;
  onDelete: (memory: Memory) => void;
}) {
  const { data: memory, isLoading, error, refetch } = useMemory(projectId, name);
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        data-testid="memory-detail"
        className="w-screen max-w-full sm:w-[860px] sm:max-w-[96vw]"
      >
        <SheetHeader>
          <SheetTitle>{name}</SheetTitle>
          {memory && (
            <p
              data-testid="memory-detail-description"
              className="font-body text-sm text-muted-foreground mt-1"
            >
              {memory.description}
            </p>
          )}
        </SheetHeader>
        <SheetBody>
          {error ? (
            <ErrorState message={error.message} onRetry={() => void refetch()} />
          ) : isLoading || !memory ? (
            <div className="space-y-3">
              {[...Array(4)].map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
                <Skeleton key={i} className="h-8 w-full bg-surface-highest" />
              ))}
            </div>
          ) : (
            <div className="space-y-6">
              <div className="flex flex-wrap gap-2">
                <Button
                  data-testid="memory-edit"
                  size="sm"
                  variant="outline"
                  onClick={() => onEdit(memory)}
                >
                  <Pencil size={12} className="mr-1" /> Edit
                </Button>
                <Button
                  data-testid="memory-delete"
                  size="sm"
                  variant="outline"
                  onClick={() => onDelete(memory)}
                >
                  <Trash2 size={12} className="mr-1" /> Delete
                </Button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <DetailField label="Project">{projectName}</DetailField>
                <DetailField label="Priority">
                  <MemoryPriority priority={memory.priority} />
                </DetailField>
                <DetailField label="Reads">
                  {listItem ? <span title={readsTitle(listItem)}>{listItem.read_count}</span> : "—"}
                </DetailField>
                <DetailField label="Author">
                  <span data-testid="memory-detail-author">{memory.author}</span>
                </DetailField>
                <DetailField label="Session">
                  <code className="font-mono text-xs break-all">{memory.session_id ?? "—"}</code>
                </DetailField>
                <DetailField label="Updated">{formatTime(memory.updated_at)}</DetailField>
              </div>
              <div>
                <div className="font-label text-sm text-muted-foreground mb-2">Content</div>
                <div
                  data-testid="memory-detail-content"
                  className="whitespace-pre-wrap break-words font-body text-sm text-on-surface border border-outline-variant p-3"
                >
                  {memory.content}
                </div>
              </div>
              <MemoryHistoryPanel projectId={projectId} name={name} onDeleted={onClose} />
            </div>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

function SnapshotView({ label, snapshot }: { label: string; snapshot: MemorySnapshot | null }) {
  return (
    <div>
      <p className="text-xs text-outline mt-2">{label}</p>
      {snapshot ? (
        <div className="text-xs space-y-1">
          <p>
            <span className="text-outline">Priority:</span>{" "}
            {snapshot.priority === null ? "unscored" : snapshot.priority}
          </p>
          <p>
            <span className="text-outline">Description:</span> {snapshot.description}
          </p>
          <pre className="whitespace-pre-wrap break-all">{snapshot.content}</pre>
        </div>
      ) : (
        <p className="text-xs italic text-muted-foreground">(none)</p>
      )}
    </div>
  );
}

function MemoryHistoryPanel({
  projectId,
  name,
  onDeleted,
}: {
  projectId: string;
  name: string;
  onDeleted: () => void;
}) {
  const history = useMemoryHistory(projectId, name);
  const revert = useRevertMemory();
  const [reason, setReason] = useState("");
  const changes = history.data?.changes ?? [];
  const latest = changes[0];
  return (
    <section data-testid="memory-history-panel" className="space-y-3">
      <h3 className="text-sm font-medium">History</h3>
      {history.error && <p role="alert">{history.error.message}</p>}
      {revert.error && (
        <p role="alert" className="text-sm text-destructive">
          {revert.error.message}
        </p>
      )}
      {changes.length > 1 && (
        <Input
          data-testid="memory-revert-reason"
          aria-label="Reason for reverting"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Reason for reverting..."
        />
      )}
      {changes.map((change) => (
        <details
          key={change.id}
          data-testid="memory-history-change"
          className="border-b border-outline-variant p-3"
        >
          <summary className="text-xs cursor-pointer">
            {change.action.replace("memory.", "")} · {formatTime(change.created_at)} ·{" "}
            {change.author}
            {change.session_id ? ` · ${change.session_id}` : ""}
            {change.reason ? ` · ${change.reason}` : ""}
          </summary>
          <SnapshotView label="Before" snapshot={change.previous} />
          <SnapshotView label="After" snapshot={change.current} />
          {latest && change.previous && (
            <Button
              data-testid="memory-revert-change"
              size="sm"
              variant="outline"
              className="mt-2"
              disabled={!reason.trim() || revert.isPending}
              onClick={() =>
                revert.mutate(
                  {
                    name,
                    project_id: projectId,
                    change_id: change.id,
                    expected_change_id: latest.id,
                    reason: reason.trim(),
                  },
                  {
                    onSuccess: ({ memory }) => {
                      setReason("");
                      if (!memory) onDeleted();
                    },
                  },
                )
              }
            >
              Restore state before this change
            </Button>
          )}
        </details>
      ))}
    </section>
  );
}

function CharCount({ value, max, testId }: { value: string; max: number; testId: string }) {
  return (
    <span
      data-testid={testId}
      className={`text-xs ${value.length > max ? "text-destructive" : "text-muted-foreground"}`}
    >
      {value.length}/{max}
    </span>
  );
}

function MemoryFormDialog({
  memory,
  defaultProjectId,
  onClose,
  onCreated,
}: {
  memory: Memory | null;
  defaultProjectId: string;
  onClose: () => void;
  onCreated: (memory: Memory) => void;
}) {
  const { data: projects } = useProjects({ status: "active" });
  const [projectId, setProjectId] = useState(memory?.project_id ?? defaultProjectId);
  const [name, setName] = useState(memory?.name ?? "");
  const [description, setDescription] = useState(memory?.description ?? "");
  const [content, setContent] = useState(memory?.content ?? "");
  const [priority, setPriority] = useState(
    memory?.priority === null || memory?.priority === undefined ? "" : String(memory.priority),
  );
  const [reason, setReason] = useState("");
  const createMemory = useCreateMemory();
  const updateMemory = useUpdateMemory();
  const mutation = memory ? updateMemory : createMemory;

  const priorityValue = priority.trim() === "" ? null : Number(priority);
  const priorityValid =
    priorityValue === null ||
    (Number.isInteger(priorityValue) && priorityValue >= 0 && priorityValue <= MEMORY_PRIORITY_MAX);
  const valid =
    Boolean(projectId) &&
    Boolean(name.trim()) &&
    Boolean(description.trim()) &&
    description.length <= MEMORY_DESCRIPTION_MAX &&
    Boolean(content.trim()) &&
    priorityValid;

  function submit(): void {
    if (!valid || mutation.isPending) return;
    if (!memory) {
      createMemory.mutate(
        {
          project_id: projectId,
          name: name.trim(),
          description: description.trim(),
          content: content.trim(),
          priority: priorityValue,
        },
        {
          onSuccess: (created) => {
            onClose();
            onCreated(created);
          },
        },
      );
      return;
    }
    const changes = {
      ...(description.trim() !== memory.description && { description: description.trim() }),
      ...(content.trim() !== memory.content && { content: content.trim() }),
      ...(priorityValue !== memory.priority && { priority: priorityValue }),
    };
    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    updateMemory.mutate(
      {
        name: memory.name,
        project_id: memory.project_id,
        ...changes,
        ...(reason.trim() && { reason: reason.trim() }),
      },
      { onSuccess: onClose },
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !mutation.isPending && onClose()}>
      <DialogContent
        data-testid="memory-form-dialog"
        className="bg-surface border-outline-variant w-[calc(100%_-_1rem)] max-w-2xl max-h-[94dvh] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle className="font-headline text-base text-on-surface">
            {memory ? `Edit ${memory.name}` : "New memory"}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          className="space-y-3 mt-2"
        >
          {!memory && (
            <>
              <div className="space-y-1.5">
                <Label className="font-label text-sm text-muted-foreground">Project *</Label>
                <Select value={projectId} onValueChange={setProjectId}>
                  <SelectTrigger
                    aria-label="Memory project"
                    data-testid="memory-project-select"
                    className="bg-background text-on-surface font-body text-sm h-9"
                  >
                    <SelectValue placeholder="Choose a project" />
                  </SelectTrigger>
                  <SelectContent className="bg-surface border-outline-variant">
                    {projects?.map((p) => (
                      <SelectItem key={p.id} value={p.id} className="font-body text-sm">
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="font-label text-sm text-muted-foreground">Name *</Label>
                <Input
                  aria-label="Name"
                  data-testid="memory-name-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="api-port"
                  maxLength={64}
                  className="bg-background text-on-surface font-body text-sm"
                  autoFocus
                />
                <p className="text-xs text-muted-foreground">
                  Lowercase words joined by hyphens, unique in the project.
                </p>
              </div>
            </>
          )}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="font-label text-sm text-muted-foreground">Description *</Label>
              <CharCount
                value={description}
                max={MEMORY_DESCRIPTION_MAX}
                testId="memory-description-count"
              />
            </div>
            <Textarea
              aria-label="Description"
              data-testid="memory-description-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="One line agents see in lists and context"
              className="bg-background text-on-surface font-body text-sm resize-none"
              rows={2}
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="font-label text-sm text-muted-foreground">Content *</Label>
              <CharCount value={content} max={MEMORY_CONTENT_MAX} testId="memory-content-count" />
            </div>
            <Textarea
              aria-label="Content"
              data-testid="memory-content-input"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="The fact itself. Longer guidance belongs in a skill."
              className="bg-background text-on-surface font-body text-sm"
              rows={6}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-sm text-muted-foreground">
              Priority (0-{MEMORY_PRIORITY_MAX}, empty = unscored)
            </Label>
            <Input
              aria-label="Priority"
              data-testid="memory-priority-input"
              type="number"
              min={0}
              max={MEMORY_PRIORITY_MAX}
              step={1}
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              className="w-32 bg-background text-on-surface font-body text-sm"
            />
            {!priorityValid && (
              <p className="text-xs text-destructive">
                Priority must be a whole number from 0 to {MEMORY_PRIORITY_MAX}.
              </p>
            )}
          </div>
          {memory && (
            <div className="space-y-1.5">
              <Label className="font-label text-sm text-muted-foreground">Reason</Label>
              <Input
                aria-label="Reason"
                data-testid="memory-reason-input"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why this changed (optional)"
                className="bg-background text-on-surface font-body text-sm"
              />
            </div>
          )}
          {mutation.error && (
            <p role="alert" data-testid="memory-form-error" className="text-sm text-destructive">
              {mutation.error.message}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              disabled={mutation.isPending}
              className="font-label text-sm text-muted-foreground"
            >
              Cancel
            </Button>
            <Button
              data-testid="memory-submit"
              type="submit"
              size="sm"
              disabled={!valid || mutation.isPending}
              className="font-label text-sm"
            >
              {mutation.isPending ? "Saving..." : memory ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
