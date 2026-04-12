import { useState } from "react";
import { Search, Trash2, X } from "lucide-react";
import { useMemories, useMemorySearch, useCreateMemory, useDeleteMemory } from "@/hooks/useMemories";
import { ViewHeader } from "@/components/ViewHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";

const IMPORTANCE_COLORS: Record<string, string> = {
  critical: "text-error", high: "text-tertiary",
  normal: "text-on-surface-variant", low: "text-outline",
};

export default function Memories() {
  const [query, setQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [creating, setCreating] = useState(false);
  const deleteMemory = useDeleteMemory();

  const listResult = useMemories();
  const searchResult = useMemorySearch(query);

  const isSearching = query.trim().length > 0;
  const { data, isLoading, error, refetch } = isSearching ? searchResult : listResult;
  const memories = data ?? [];

  if (error && !isSearching) return <ErrorState message={(error as Error).message} onRetry={() => refetch()} />;

  return (
    <div>
      <ViewHeader
        title="Memories"
        meta={`${memories.length} shown`}
        action={
          <Button size="sm" onClick={() => setCreating(true)}
            className="font-label text-xs uppercase tracking-widest bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20">
            + New Memory
          </Button>
        }
      />

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
        <Button size="sm" onClick={() => setQuery(searchInput)}
          className="font-label text-xs uppercase bg-primary/10 text-primary border border-primary/30">
          Search
        </Button>
        {query && (
          <Button size="sm" variant="ghost" onClick={() => { setQuery(""); setSearchInput(""); }}
            className="font-label text-xs text-outline">
            <X size={12} className="mr-1" /> Clear
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-10 w-full bg-surface-highest" />)}
        </div>
      ) : memories.length === 0 ? (
        <EmptyState message={isSearching ? "No results" : "No memories"} />
      ) : (
        <div className="border border-surface-highest rounded-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-surface-highest hover:bg-transparent">
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">Content</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-28">Scope</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">Importance</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-40">Tags</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">Created</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {memories.map((mem) => (
                <TableRow key={mem.id} className="border-b border-surface-highest/50 hover:bg-surface-low">
                  <TableCell className="font-body text-xs text-on-surface max-w-xs truncate">{mem.content}</TableCell>
                  <TableCell className="font-label text-[10px] text-outline">{mem.scope ?? "—"}</TableCell>
                  <TableCell className="font-label text-[10px]">
                    <span className={IMPORTANCE_COLORS[mem.importance] ?? "text-outline"}>
                      {mem.importance}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {(mem.tags ?? []).map((t) => (
                        <span key={t} className="font-label text-[9px] px-1.5 py-0.5 bg-surface-highest text-outline border border-surface-highest/50">
                          {t}
                        </span>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="font-label text-[10px] text-outline">
                    {new Date(mem.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <button onClick={() => deleteMemory.mutate(mem.id)}
                      className="text-outline hover:text-error transition-colors p-1">
                      <Trash2 size={12} />
                    </button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {creating && <CreateMemoryDialog open={creating} onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateMemoryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [content, setContent] = useState("");
  const [scope, setScope] = useState("");
  const [tags, setTags] = useState("");
  const createMemory = useCreateMemory();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;
    const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean);
    createMemory.mutate(
      { content: content.trim(), scope: scope.trim() || undefined, tags: tagList.length ? tagList : undefined },
      { onSuccess: () => { setContent(""); setScope(""); setTags(""); onClose(); } },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="bg-surface border-surface-highest max-w-md">
        <DialogHeader>
          <DialogTitle className="font-headline text-sm uppercase tracking-widest text-on-surface">New Memory</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">Content *</Label>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Memory content..."
              className="bg-background border-surface-highest text-on-surface font-body text-xs resize-none"
              rows={4}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">Scope</Label>
            <Input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="e.g. project:orc, global"
              className="bg-background border-surface-highest text-on-surface font-body text-xs" />
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">Tags (comma-separated)</Label>
            <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tag1, tag2, ..."
              className="bg-background border-surface-highest text-on-surface font-body text-xs" />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}
              className="font-label text-xs uppercase text-outline">Cancel</Button>
            <Button type="submit" size="sm" disabled={createMemory.isPending || !content.trim()}
              className="font-label text-xs uppercase bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25">
              {createMemory.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
