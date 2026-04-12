import { FileText, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { useState } from "react";
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
import { ScrollArea } from "@/components/ui/scroll-area";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ViewHeader } from "@/components/ViewHeader";
import {
  useAddKnowledgeCollection,
  useKnowledgeCollections,
  useKnowledgeDocument,
  useKnowledgeSearch,
  useKnowledgeStatus,
  useReindexKnowledge,
  useRemoveKnowledgeCollection,
} from "@/hooks/useKnowledge";

export default function Knowledge({ projectId }: { projectId: string }) {
  const [tab, setTab] = useState<"search" | "collections">("search");
  const pid = projectId === "all" ? undefined : projectId;

  const { data: statusData } = useKnowledgeStatus();
  const totalDocs = statusData?.totalDocuments ?? 0;
  const searchMode = statusData?.searchMode ?? "unknown";

  return (
    <div>
      <ViewHeader title="Knowledge" meta={`${totalDocs} documents \u00b7 ${searchMode}`} />

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as "search" | "collections")}
        className="mb-4"
      >
        <TabsList className="bg-surface-highest border border-surface-highest gap-0 h-auto p-0">
          <TabsTrigger
            value="search"
            className="font-label text-[10px] uppercase tracking-widest px-4 py-2 rounded-none
              data-[state=active]:bg-primary/15 data-[state=active]:text-primary data-[state=active]:shadow-none
              text-outline hover:text-on-surface-variant"
          >
            Search
          </TabsTrigger>
          <TabsTrigger
            value="collections"
            className="font-label text-[10px] uppercase tracking-widest px-4 py-2 rounded-none
              data-[state=active]:bg-primary/15 data-[state=active]:text-primary data-[state=active]:shadow-none
              text-outline hover:text-on-surface-variant"
          >
            Collections
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === "search" ? <SearchTab projectId={pid} /> : <CollectionsTab projectId={pid} />}
    </div>
  );
}

function SearchTab({ projectId }: { projectId?: string }) {
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [collection, setCollection] = useState<string>("__all__");
  const [selectedDoc, setSelectedDoc] = useState<string | null>(null);

  const { data: collections } = useKnowledgeCollections({
    project_id: projectId,
  });
  const { data: results, isLoading: isSearching } = useKnowledgeSearch(query, {
    collection: collection === "__all__" ? undefined : collection,
    project_id: projectId,
    limit: 20,
  });
  const { data: document, isLoading: isDocLoading } = useKnowledgeDocument(selectedDoc);

  const handleSearch = () => {
    setQuery(searchInput);
  };

  return (
    <div>
      <div className="flex gap-2 mb-6">
        <div className="relative flex-1">
          <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-outline" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder="Search knowledge base..."
            className="pl-8 bg-surface-highest border-surface-highest text-on-surface font-body text-xs"
          />
        </div>
        <Select value={collection} onValueChange={setCollection}>
          <SelectTrigger className="w-40 bg-surface-highest border-surface-highest text-on-surface font-label text-[10px]">
            <SelectValue placeholder="All collections" />
          </SelectTrigger>
          <SelectContent className="bg-surface-highest border-surface-highest">
            <SelectItem value="__all__" className="font-label text-xs">
              All collections
            </SelectItem>
            {(collections ?? []).map((c) => (
              <SelectItem key={c.name} value={c.name} className="font-label text-xs">
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          onClick={handleSearch}
          className="font-label text-xs uppercase bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20"
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
            Clear
          </Button>
        )}
      </div>

      {query && (
        <div>
          <div className="font-label text-[9px] uppercase tracking-widest text-outline mb-3">
            Search Results
          </div>
          {isSearching ? (
            <Skeleton className="h-20 w-full bg-surface-highest" />
          ) : (results ?? []).length === 0 ? (
            <EmptyState message="No results" />
          ) : (
            <div className="grid gap-3">
              {(results ?? []).map((r) => (
                <button
                  key={r.docid}
                  type="button"
                  className="w-full text-left border border-surface-highest rounded-sm p-4 hover:bg-surface-low transition-colors"
                  onClick={() => setSelectedDoc(r.docid)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <FileText size={12} className="text-primary flex-shrink-0" />
                        <span className="font-body text-xs font-semibold text-on-surface truncate">
                          {r.title || r.path}
                        </span>
                      </div>
                      {r.path && r.title && (
                        <div className="font-mono text-[10px] text-outline truncate mb-1">
                          {r.path}
                        </div>
                      )}
                      <div className="font-label text-[10px] text-primary mb-2">{r.collection}</div>
                      <div className="font-body text-[10px] text-outline line-clamp-2">
                        {r.snippet}
                      </div>
                    </div>
                    <span className="font-label text-[10px] text-outline bg-surface-highest px-1.5 py-0.5 rounded-sm flex-shrink-0">
                      {r.score.toFixed(2)}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <Sheet open={Boolean(selectedDoc)} onOpenChange={(v) => !v && setSelectedDoc(null)}>
        <SheetContent side="right" className="w-[540px] max-w-[90vw]">
          <SheetHeader>
            <SheetTitle>
              {isDocLoading
                ? "Loading..."
                : document
                  ? document.title || document.path
                  : "Document"}
            </SheetTitle>
          </SheetHeader>
          <SheetBody>
            {isDocLoading ? (
              <div className="space-y-4">
                {[...Array(3)].map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full bg-surface-highest" />
                ))}
              </div>
            ) : !document ? (
              <div className="font-body text-xs text-outline py-8 text-center">
                Document not found
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <DetailField label="Collection">{document.collection}</DetailField>
                  <DetailField label="Path">
                    <span className="font-mono text-[10px]">{document.path}</span>
                  </DetailField>
                  <DetailField label="Modified">
                    {new Date(document.modifiedAt).toLocaleString()}
                  </DetailField>
                  <DetailField label="Doc ID">
                    <span className="font-mono text-[10px]">{document.docid}</span>
                  </DetailField>
                </div>
                <div>
                  <div className="font-label text-[10px] uppercase tracking-widest text-outline mb-2">
                    Content
                  </div>
                  <ScrollArea className="h-[400px]">
                    <pre className="font-mono text-[10px] text-on-surface-variant whitespace-pre-wrap bg-surface-highest/50 border border-surface-highest rounded-sm p-3">
                      {document.content}
                    </pre>
                  </ScrollArea>
                </div>
              </div>
            )}
          </SheetBody>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function CollectionsTab({ projectId }: { projectId?: string }) {
  const {
    data: collections,
    isLoading,
    error,
  } = useKnowledgeCollections({ project_id: projectId });
  const reindex = useReindexKnowledge();
  const removeCollection = useRemoveKnowledgeCollection();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  if (error) return <ErrorState message={(error as Error).message} />;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="font-label text-[9px] uppercase tracking-widest text-outline">
          Collections
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => reindex.mutate(undefined)}
            disabled={reindex.isPending}
            className="font-label text-[10px] uppercase tracking-widest text-outline"
          >
            <RefreshCw size={12} className={`mr-1 ${reindex.isPending ? "animate-spin" : ""}`} />
            {reindex.isPending ? "Indexing..." : "Reindex All"}
          </Button>
          <Button
            size="sm"
            onClick={() => setCreating(true)}
            className="font-label text-xs uppercase tracking-widest bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20"
          >
            <Plus size={12} className="mr-1" />
            Add Collection
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-10 w-full bg-surface-highest" />
          ))}
        </div>
      ) : (collections ?? []).length === 0 ? (
        <EmptyState message="No collections" />
      ) : (
        <div className="border border-surface-highest rounded-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-surface-highest hover:bg-transparent">
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">
                  Name
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">
                  Path
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">
                  Pattern
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-20">
                  Docs
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-36">
                  Last Modified
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">
                  Project
                </TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(collections ?? []).map((c) => (
                <TableRow
                  key={c.name}
                  className="border-b border-surface-highest/50 hover:bg-surface-low"
                >
                  <TableCell className="font-label text-xs font-semibold text-primary">
                    {c.name}
                  </TableCell>
                  <TableCell className="font-body text-[10px] text-outline truncate max-w-xs">
                    {c.path}
                  </TableCell>
                  <TableCell className="font-mono text-[10px] text-outline">{c.pattern}</TableCell>
                  <TableCell className="font-label text-xs text-on-surface text-center">
                    {c.documentCount}
                  </TableCell>
                  <TableCell className="font-label text-[10px] text-outline">
                    {c.lastModified ? new Date(c.lastModified).toLocaleDateString() : "\u2014"}
                  </TableCell>
                  <TableCell className="font-label text-[10px] text-outline">
                    {c.projectId ? c.projectId.slice(-6) : "\u2014"}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => reindex.mutate({ collections: [c.name] })}
                        disabled={reindex.isPending}
                        className="text-outline hover:text-primary transition-colors p-1"
                        title="Reindex"
                      >
                        <RefreshCw size={12} className={reindex.isPending ? "animate-spin" : ""} />
                      </button>
                      <button
                        onClick={() => setDeleting(c.name)}
                        className="text-outline hover:text-error transition-colors p-1"
                        title="Delete"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {creating && (
        <AddCollectionDialog
          open={creating}
          projectId={projectId}
          onClose={() => setCreating(false)}
        />
      )}

      {deleting && (
        <ConfirmDialog
          open={Boolean(deleting)}
          title="Delete Collection"
          description={`Remove collection "${deleting}" and all indexed documents from the knowledge base?`}
          confirmLabel="Delete"
          variant="destructive"
          isPending={removeCollection.isPending}
          onConfirm={() => {
            removeCollection.mutate(deleting, {
              onSuccess: () => setDeleting(null),
            });
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

function AddCollectionDialog({
  open,
  projectId,
  onClose,
}: {
  open: boolean;
  projectId?: string;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [pattern, setPattern] = useState("**/*.md");
  const [projId, setProjId] = useState(projectId ?? "");
  const addCollection = useAddKnowledgeCollection();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !path.trim()) return;
    addCollection.mutate(
      {
        name: name.trim(),
        path: path.trim(),
        pattern: pattern.trim() || undefined,
        project_id: projId.trim() || undefined,
      },
      {
        onSuccess: () => onClose(),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="bg-surface border-surface-highest max-w-md">
        <DialogHeader>
          <DialogTitle className="font-headline text-sm uppercase tracking-widest text-on-surface">
            Add Collection
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
              Name *
            </Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-docs"
              className="bg-background border-surface-highest text-on-surface font-body text-xs"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
              Path *
            </Label>
            <Input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/path/to/documents"
              className="bg-background border-surface-highest text-on-surface font-body text-xs"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Pattern
              </Label>
              <Input
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder="**/*.md"
                className="bg-background border-surface-highest text-on-surface font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Project ID
              </Label>
              <Input
                value={projId}
                onChange={(e) => setProjId(e.target.value)}
                placeholder="Optional"
                className="bg-background border-surface-highest text-on-surface font-body text-xs"
              />
            </div>
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
              disabled={addCollection.isPending || !name.trim() || !path.trim()}
              className="font-label text-xs uppercase bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25"
            >
              {addCollection.isPending ? "Adding..." : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
