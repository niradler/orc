import { Plus, Search, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { CreateMemoryInput, Memory, MemoryType, UpdateMemoryInput } from "@/api/client";
import { ConfirmDialog } from "@/components/ConfirmDialog";
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
import { useDetailRoute } from "@/hooks/useDetailRoute";
import {
  useCreateMemory,
  useDeleteMemory,
  useMemories,
  useMemorySearch,
  useUpdateMemory,
} from "@/hooks/useMemories";
import { useProjectScope } from "@/hooks/useProjectScope";
import { useProjects } from "@/hooks/useProjects";

const MEMORY_TYPES: MemoryType[] = ["fact", "decision", "event", "rule", "discovery"];

const TYPE_TABS: Array<{ value: MemoryType | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "fact", label: "Fact" },
  { value: "decision", label: "Decision" },
  { value: "event", label: "Event" },
  { value: "rule", label: "Rule" },
  { value: "discovery", label: "Discovery" },
];

const IMPORTANCE_COLORS: Record<string, string> = {
  critical: "bg-error/15 text-error border-error/30",
  high: "bg-tertiary/15 text-tertiary border-tertiary/30",
  normal: "bg-surface-highest text-on-surface-variant border-surface-highest/50",
  low: "bg-surface-highest text-outline border-surface-highest/50",
};

const TYPE_COLORS: Record<string, string> = {
  rule: "bg-primary/15 text-primary border-primary/30",
  decision: "bg-tertiary/15 text-tertiary border-tertiary/30",
  discovery: "bg-secondary/15 text-secondary border-secondary/30",
  event: "bg-surface-highest text-on-surface-variant border-surface-highest/50",
  fact: "bg-surface-highest text-outline border-surface-highest/50",
};

const IMPORTANCES = ["low", "normal", "high", "critical"] as const;

export default function Memories({ projectId: savedProjectId }: { projectId: string }) {
  const projectId = useProjectScope(savedProjectId);
  const [query, setQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [typeFilter, setTypeFilter] = useState<MemoryType | "all">("all");
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Memory | null>(null);
  const {
    selectedId: editingId,
    openDetail: openEdit,
    closeDetail: closeEdit,
  } = useDetailRoute("/memories", "memoryId");

  const deleteMemory = useDeleteMemory();

  const scopedProjectId = projectId === "all" ? undefined : projectId;
  const listResult = useMemories({ project_id: scopedProjectId });
  const searchResult = useMemorySearch(query, { project_id: scopedProjectId });

  const isSearching = query.trim().length > 0;
  const { data, isLoading, error, refetch } = isSearching ? searchResult : listResult;
  const allMemories = data ?? [];
  const editing = editingId ? (allMemories.find((m) => m.id === editingId) ?? null) : null;

  const filtered = useMemo(() => {
    if (typeFilter === "all") return allMemories;
    return allMemories.filter((m) => m.type === typeFilter);
  }, [allMemories, typeFilter]);

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = { all: allMemories.length };
    for (const m of allMemories) {
      counts[m.type] = (counts[m.type] ?? 0) + 1;
    }
    return counts;
  }, [allMemories]);

  if (error && !isSearching)
    return <ErrorState message={(error as Error).message} onRetry={() => refetch()} />;

  return (
    <div>
      <ViewHeader
        title="Memories"
        meta={`${filtered.length} shown`}
        action={
          <Button
            data-testid="new-memory-button"
            size="sm"
            onClick={() => setCreating(true)}
            className="font-label text-xs uppercase tracking-widest bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20"
          >
            <Plus size={12} className="mr-1" /> New Memory
          </Button>
        }
      />

      {/* Type filter tabs */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {TYPE_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => setTypeFilter(tab.value)}
            className={`font-label text-[10px] uppercase tracking-widest px-3 py-1.5 border transition-colors ${
              typeFilter === tab.value
                ? "bg-primary/15 text-primary border-primary/30"
                : "bg-surface-highest border-surface-highest text-outline hover:text-on-surface-variant"
            }`}
          >
            {tab.label}
            <span className="ml-1.5 opacity-70">{typeCounts[tab.value] ?? 0}</span>
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="flex gap-2 mb-4">
        <div className="relative flex-1">
          <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-outline" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setQuery(searchInput)}
            placeholder="Search memories..."
            className="pl-8 bg-surface-highest border-surface-highest text-on-surface font-body text-xs placeholder:text-outline"
          />
        </div>
        <Button
          size="sm"
          onClick={() => setQuery(searchInput)}
          className="font-label text-xs uppercase bg-primary/10 text-primary border border-primary/30"
        >
          Search
        </Button>
        {query && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setQuery("");
              setSearchInput("");
            }}
            className="font-label text-xs text-outline"
          >
            <X size={12} className="mr-1" /> Clear
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <Skeleton key={i} className="h-10 w-full bg-surface-highest" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState message={isSearching ? "No results" : "No memories"} />
      ) : (
        <div className="border border-surface-highest rounded-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-surface-highest hover:bg-transparent">
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">
                  Title
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">
                  Type
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">
                  Importance
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">
                  Source
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-36">
                  Tags
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">
                  Created
                </TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((mem) => (
                <TableRow
                  key={mem.id}
                  data-testid="memory-row"
                  data-memory-id={mem.id}
                  className="border-b border-surface-highest/50 hover:bg-surface-low cursor-pointer"
                  onClick={() => openEdit(mem.id)}
                >
                  <TableCell className="font-body text-xs text-on-surface max-w-xs truncate">
                    {mem.title || mem.content.slice(0, 80)}
                  </TableCell>
                  <TableCell>
                    <span
                      className={`inline-flex px-2 py-0.5 font-label text-[10px] uppercase tracking-wider border ${TYPE_COLORS[mem.type] ?? ""}`}
                    >
                      {mem.type}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span
                      className={`inline-flex px-2 py-0.5 font-label text-[10px] uppercase tracking-wider border ${IMPORTANCE_COLORS[mem.importance] ?? ""}`}
                    >
                      {mem.importance}
                    </span>
                  </TableCell>
                  <TableCell className="font-label text-[10px] text-outline">
                    {mem.source ?? "\u2014"}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {(mem.tags ?? []).map((t) => (
                        <span
                          key={t}
                          className="font-label text-[9px] px-1.5 py-0.5 bg-surface-highest text-outline border border-surface-highest/50"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="font-label text-[10px] text-outline">
                    {new Date(mem.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      data-testid="memory-delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleting(mem);
                      }}
                      className="text-outline hover:text-error transition-colors p-1"
                    >
                      <Trash2 size={12} />
                    </button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {creating && (
        <CreateMemoryDialog
          defaultProjectId={scopedProjectId}
          open={creating}
          onClose={() => setCreating(false)}
        />
      )}

      {editing && (
        <EditMemoryDialog
          key={editing.id}
          memory={editing}
          open={Boolean(editing)}
          onClose={closeEdit}
        />
      )}

      {deleting && (
        <ConfirmDialog
          open={Boolean(deleting)}
          title="Delete Memory"
          description={`Delete "${deleting.title || deleting.content.slice(0, 40)}"? This cannot be undone.`}
          confirmLabel="Delete"
          variant="destructive"
          isPending={deleteMemory.isPending}
          onConfirm={() => {
            deleteMemory.mutate(deleting.id, {
              onSuccess: () => setDeleting(null),
            });
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

function CreateMemoryDialog({
  defaultProjectId,
  open,
  onClose,
}: {
  defaultProjectId?: string;
  open: boolean;
  onClose: () => void;
}) {
  const { data: projects } = useProjects();
  const [title, setTitle] = useState("");
  const [type, setType] = useState<MemoryType>("fact");
  const [content, setContent] = useState("");
  const [source, setSource] = useState("");
  const [scope, setScope] = useState("");
  const [tags, setTags] = useState("");
  const [importance, setImportance] = useState<CreateMemoryInput["importance"]>("normal");
  const [expiresAt, setExpiresAt] = useState("");
  const [projectId, setProjectId] = useState<string>(defaultProjectId ?? "");
  const createMemory = useCreateMemory();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;
    const tagList = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const input: CreateMemoryInput = {
      content: title.trim() ? `${title.trim()}\n\n${content.trim()}` : content.trim(),
      project_id: projectId || undefined,
      type,
      source: source.trim() || undefined,
      scope: scope.trim() || undefined,
      tags: tagList.length ? tagList : undefined,
      importance,
      expires_at: expiresAt || undefined,
    };
    createMemory.mutate(input, { onSuccess: onClose });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="bg-surface border-surface-highest max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-headline text-sm uppercase tracking-widest text-on-surface">
            New Memory
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3 mt-2">
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
              Title
            </Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Optional title..."
              className="bg-background border-surface-highest text-on-surface font-body text-xs"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Type
              </Label>
              <Select value={type} onValueChange={(v) => setType(v as MemoryType)}>
                <SelectTrigger className="bg-background border-surface-highest text-on-surface font-body text-xs h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-surface border-surface-highest">
                  {MEMORY_TYPES.map((t) => (
                    <SelectItem key={t} value={t} className="font-body text-xs">
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Importance
              </Label>
              <Select
                value={importance}
                onValueChange={(v) => setImportance(v as CreateMemoryInput["importance"])}
              >
                <SelectTrigger className="bg-background border-surface-highest text-on-surface font-body text-xs h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-surface border-surface-highest">
                  {IMPORTANCES.map((i) => (
                    <SelectItem key={i} value={i} className="font-body text-xs">
                      {i}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
              Content *
            </Label>
            <Textarea
              data-testid="memory-content-input"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Memory content..."
              className="bg-background border-surface-highest text-on-surface font-body text-xs resize-none"
              rows={4}
              autoFocus
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Source
              </Label>
              <Input
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="e.g. claude-code"
                className="bg-background border-surface-highest text-on-surface font-body text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Scope
              </Label>
              <Input
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                placeholder="e.g. project:orc"
                className="bg-background border-surface-highest text-on-surface font-body text-xs"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Tags (comma-separated)
              </Label>
              <Input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="tag1, tag2, ..."
                className="bg-background border-surface-highest text-on-surface font-body text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Expires At
              </Label>
              <Input
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="bg-background border-surface-highest text-on-surface font-body text-xs"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
              Project
            </Label>
            <Select
              value={projectId || "__none__"}
              onValueChange={(v) => setProjectId(v === "__none__" ? "" : v)}
            >
              <SelectTrigger
                data-testid="memory-project-select"
                className="bg-background border-surface-highest text-on-surface font-body text-xs h-9"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-surface border-surface-highest">
                <SelectItem value="__none__" className="font-body text-xs">
                  None
                </SelectItem>
                {projects?.map((p) => (
                  <SelectItem key={p.id} value={p.id} className="font-body text-xs">
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="font-label text-xs uppercase text-outline"
            >
              Cancel
            </Button>
            <Button
              data-testid="memory-submit"
              type="submit"
              size="sm"
              disabled={createMemory.isPending || !content.trim()}
              className="font-label text-xs uppercase bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25"
            >
              {createMemory.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditMemoryDialog({
  memory,
  open,
  onClose,
}: {
  memory: Memory;
  open: boolean;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(memory.title ?? "");
  const [type, setType] = useState<MemoryType>(memory.type);
  const [content, setContent] = useState(memory.content);
  const [source, setSource] = useState(memory.source ?? "");
  const [scope, setScope] = useState(memory.scope ?? "");
  const [tags, setTags] = useState((memory.tags ?? []).join(", "));
  const [importance, setImportance] = useState<UpdateMemoryInput["importance"]>(memory.importance);
  const updateMemory = useUpdateMemory();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;
    const tagList = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const input: UpdateMemoryInput & { id: string } = {
      id: memory.id,
      title: title.trim() || undefined,
      content: content.trim(),
      type,
      source: source.trim() || undefined,
      scope: scope.trim() || undefined,
      tags: tagList.length ? tagList : undefined,
      importance,
    };
    updateMemory.mutate(input, { onSuccess: onClose });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="bg-surface border-surface-highest max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-headline text-sm uppercase tracking-widest text-on-surface">
            Edit Memory
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3 mt-2">
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
              Title
            </Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Optional title..."
              className="bg-background border-surface-highest text-on-surface font-body text-xs"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Type
              </Label>
              <Select value={type} onValueChange={(v) => setType(v as MemoryType)}>
                <SelectTrigger className="bg-background border-surface-highest text-on-surface font-body text-xs h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-surface border-surface-highest">
                  {MEMORY_TYPES.map((t) => (
                    <SelectItem key={t} value={t} className="font-body text-xs">
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Importance
              </Label>
              <Select
                value={importance}
                onValueChange={(v) => setImportance(v as UpdateMemoryInput["importance"])}
              >
                <SelectTrigger className="bg-background border-surface-highest text-on-surface font-body text-xs h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-surface border-surface-highest">
                  {IMPORTANCES.map((i) => (
                    <SelectItem key={i} value={i} className="font-body text-xs">
                      {i}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
              Content *
            </Label>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Memory content..."
              className="bg-background border-surface-highest text-on-surface font-body text-xs resize-none"
              rows={4}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Source
              </Label>
              <Input
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="e.g. claude-code"
                className="bg-background border-surface-highest text-on-surface font-body text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Scope
              </Label>
              <Input
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                placeholder="e.g. project:orc"
                className="bg-background border-surface-highest text-on-surface font-body text-xs"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
              Tags (comma-separated)
            </Label>
            <Input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="tag1, tag2, ..."
              className="bg-background border-surface-highest text-on-surface font-body text-xs"
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="font-label text-xs uppercase text-outline"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={updateMemory.isPending || !content.trim()}
              className="font-label text-xs uppercase bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25"
            >
              {updateMemory.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
