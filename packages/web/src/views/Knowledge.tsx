import { useQueryClient } from "@tanstack/react-query";
import { FileText, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "@/api/client";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DetailField } from "@/components/DetailField";
import { confirmDocumentClose, DocumentWorkspace } from "@/components/DocumentWorkspace";
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
import { useProjectScope } from "@/hooks/useProjectScope";
import { useViewParam } from "@/lib/view-params";
import { workspaceDestination } from "@/lib/workspace-navigation";
import Memories from "@/views/Memories";

export default function Knowledge({ projectId: savedProjectId }: { projectId: string }) {
  const projectId = useProjectScope(savedProjectId);
  const [searchParams] = useSearchParams();
  const { pathname, hash } = useLocation();
  const navigate = useNavigate();
  const memories = pathname.startsWith("/knowledge/memories");
  const collections =
    searchParams.get("view") === "collections" || searchParams.get("tab") === "collections";
  const setCollections = (open: boolean) => {
    if (!confirmDocumentClose(`knowledge:${searchParams.get("document")}`)) return;
    const next = new URLSearchParams(window.location.search);
    next.delete("tab");
    if (open) next.set("view", "collections");
    else next.delete("view");
    navigate({ pathname: "/knowledge/base", search: next.toString(), hash });
  };
  const pid = projectId === "all" ? undefined : projectId;

  const { data: statusData, isLoading: statusLoading, error: statusError } = useKnowledgeStatus();
  const totalDocs = statusData?.totalDocuments ?? 0;
  const searchMode = statusData?.searchMode ?? "unknown";

  // Preserve links created by the initial redesign without mixing Wiki pages with indexed files.
  if (searchParams.has("page")) {
    const next = new URLSearchParams(searchParams);
    next.delete("tab");
    return <Navigate replace to={{ pathname: "/knowledge/wiki", search: next.toString(), hash }} />;
  }

  return (
    <div data-testid="knowledge-base-view">
      {memories ? (
        <Memories projectId={savedProjectId} embedded />
      ) : (
        <>
          <ViewHeader title="Knowledge base" />
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground" role="status">
              {statusLoading
                ? "Loading index status…"
                : statusError
                  ? "Index status unavailable"
                  : `${totalDocs} indexed documents across this ORC workspace · ${searchMode}`}
            </p>
            {collections && (
              <Button
                variant="outline"
                data-testid="knowledge-back-documents"
                onClick={() => setCollections(false)}
              >
                Back to documents
              </Button>
            )}
          </div>
          {collections ? (
            <CollectionsTab projectId={pid} />
          ) : (
            <DocumentsTab
              key={projectId}
              projectId={pid}
              onManageCollections={() => setCollections(true)}
            />
          )}
        </>
      )}
    </div>
  );
}

function DocumentsTab({
  projectId,
  onManageCollections,
}: {
  projectId?: string;
  onManageCollections: () => void;
}) {
  const location = useLocation();
  const [query, setQuery] = useViewParam<string>("documentQuery", "");
  const [searchInput, setSearchInput] = useState(query);
  const [collection, setCollection] = useViewParam<string>("collection", "__all__");
  const [documentParam, setDocumentParam] = useViewParam<string>("document", "");
  const selectedDoc = documentParam || null;
  const setSelectedDoc = (value: string | null) => setDocumentParam(value ?? "");
  useEffect(() => setSearchInput(query), [query]);
  const queryClient = useQueryClient();
  const [indexingWarning, setIndexingWarning] = useState<string>();
  const documentId = `knowledge:${selectedDoc}`;

  const {
    data: collections,
    isLoading: collectionsLoading,
    error: collectionsError,
  } = useKnowledgeCollections({
    project_id: projectId,
  });
  const {
    data: results,
    isLoading: isSearching,
    error: searchError,
    refetch: retrySearch,
  } = useKnowledgeSearch(query, {
    collection: collection === "__all__" ? undefined : collection,
    project_id: projectId,
    limit: 20,
  });
  const {
    data: document,
    isLoading: isDocLoading,
    refetch: refetchDocument,
  } = useKnowledgeDocument(selectedDoc);

  const handleSearch = () => {
    setQuery(searchInput);
  };

  return (
    <div>
      <p className="mb-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Search the files indexed from your collections. Your authored lessons and linked pages live
        in{" "}
        <Link
          to={workspaceDestination("/knowledge/wiki", projectId ?? "all", location.search)}
          className="text-primary underline"
        >
          Wiki
        </Link>
        .
      </p>
      <div className="flex flex-wrap gap-2 mb-6">
        <div className="relative min-w-[180px] flex-1">
          <Search
            size={12}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            data-testid="knowledge-search-input"
            aria-label="Search indexed documents"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setQuery(e.currentTarget.value)}
            placeholder="Find an indexed document…"
            className="pl-8 bg-background text-on-surface font-body text-sm"
          />
        </div>
        <Select value={collection} onValueChange={setCollection}>
          <SelectTrigger
            aria-label="Filter document collection"
            className="w-40 bg-background text-on-surface font-label text-sm"
          >
            <SelectValue placeholder="All collections" />
          </SelectTrigger>
          <SelectContent className="bg-surface-highest border-outline-variant">
            <SelectItem value="__all__" className="font-label text-sm">
              All collections
            </SelectItem>
            {(collections ?? []).map((c) => (
              <SelectItem key={c.name} value={c.name} className="font-label text-sm">
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" onClick={handleSearch} className="font-label text-sm ">
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
            className="font-label text-sm text-muted-foreground"
          >
            Clear
          </Button>
        )}
      </div>

      {!query && (
        <section className="space-y-3" aria-label="Indexed collections">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-medium">Your document collections</h2>
            <Button
              variant="outline"
              data-testid="knowledge-manage-collections"
              onClick={onManageCollections}
            >
              Manage collections
            </Button>
          </div>
          {collectionsLoading && (
            <p role="status" data-testid="page-loading" className="text-sm text-muted-foreground">
              Loading collections…
            </p>
          )}
          {collectionsError && (
            <p role="alert" data-testid="page-error" className="text-sm text-error">
              {(collectionsError as Error).message}
            </p>
          )}
          {!collectionsLoading && !collectionsError && !collections?.length && (
            <div
              data-testid="page-empty"
              className="rounded-lg border border-dashed border-outline-variant p-6"
            >
              <h3 className="font-medium">Add files to Knowledge</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Create a collection from a folder of documents. ORC indexes matching files so you
                can find, read and edit them here.
              </p>
              <Button className="mt-4" onClick={onManageCollections}>
                Add a collection
              </Button>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {collections?.map((entry) => (
              <button
                type="button"
                data-testid="knowledge-source-collection"
                key={entry.name}
                onClick={() => setCollection(entry.name)}
                className={`min-w-0 border-b border-outline-variant p-4 text-left ${collection === entry.name ? "bg-surface-highest" : "hover:bg-surface-low"}`}
              >
                <h3 className="break-words font-medium">{entry.name}</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {entry.documentCount} indexed documents
                </p>
                <p className="mt-2 break-all text-xs text-muted-foreground">{entry.path}</p>
                <p className="mt-3 text-sm text-primary">Search this collection</p>
              </button>
            ))}
          </div>
        </section>
      )}

      {query && (
        <div>
          <div className="font-label text-sm  text-muted-foreground mb-3">
            Documents matching “{query}”
          </div>
          {searchError ? (
            <ErrorState
              message={(searchError as Error).message}
              onRetry={() => void retrySearch()}
            />
          ) : isSearching ? (
            <Skeleton className="h-20 w-full bg-surface-highest" />
          ) : (results ?? []).length === 0 ? (
            <EmptyState message="No results" />
          ) : (
            <div className="grid gap-3">
              {(results ?? []).map((r) => (
                <button
                  key={r.docid}
                  data-testid="knowledge-result"
                  type="button"
                  className="w-full text-left border-b border-outline-variant p-4 hover:bg-surface-low transition-colors"
                  onClick={() => {
                    setIndexingWarning(undefined);
                    setSelectedDoc(`qmd://${r.path}`);
                  }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <FileText size={12} className="text-muted-foreground flex-shrink-0" />
                        <span className="font-body text-sm font-medium text-on-surface truncate">
                          {r.title || r.path}
                        </span>
                      </div>
                      {r.path && r.title && (
                        <div className="font-mono text-sm text-muted-foreground truncate mb-1">
                          {r.path}
                        </div>
                      )}
                      <div className="font-label text-sm text-muted-foreground mb-2">
                        {r.collection}
                      </div>
                      <div className="font-body text-sm text-muted-foreground line-clamp-2">
                        {r.snippet}
                      </div>
                    </div>
                    <span className="font-label text-sm text-muted-foreground px-1.5 py-0.5 rounded-sm flex-shrink-0">
                      {r.score.toFixed(2)}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <Sheet
        open={Boolean(selectedDoc)}
        onOpenChange={(v) => !v && confirmDocumentClose(documentId) && setSelectedDoc(null)}
      >
        <SheetContent side="right" className="w-screen max-w-full sm:w-[1120px] sm:max-w-[96vw]">
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
                  // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
                  <Skeleton key={i} className="h-8 w-full bg-surface-highest" />
                ))}
              </div>
            ) : !document ? (
              <div className="font-body text-sm text-muted-foreground py-8 text-center">
                Document not found
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <DetailField label="Collection">{document.collection}</DetailField>
                  <DetailField label="Path">
                    <span className="font-mono text-sm">{document.path}</span>
                  </DetailField>
                  <DetailField label="Modified">
                    {new Date(document.modifiedAt).toLocaleString()}
                  </DetailField>
                  <DetailField label="Doc ID">
                    <span className="font-mono text-sm">{document.docid}</span>
                  </DetailField>
                </div>
                <div>
                  <div className="font-label text-sm  text-muted-foreground mb-2">Content</div>
                  {document.readOnlyReason && (
                    <p className="mb-3 text-sm text-muted-foreground">{document.readOnlyReason}</p>
                  )}
                  {indexingWarning && (
                    <p role="status" className="mb-3 text-sm text-muted-foreground">
                      {indexingWarning}
                    </p>
                  )}
                  <DocumentWorkspace
                    key={documentId}
                    documentId={documentId}
                    path={document.path}
                    content={document.content}
                    onSave={
                      document.editable && selectedDoc
                        ? async (content, expectedContent) => {
                            const saved = await api.knowledge
                              .editDocument(selectedDoc, content, expectedContent)
                              .catch(async (error: unknown) => {
                                await refetchDocument();
                                throw error;
                              });
                            setIndexingWarning(saved.indexingWarning);
                            await queryClient.invalidateQueries({
                              queryKey: ["knowledge-document", selectedDoc],
                            });
                            await queryClient.invalidateQueries({ queryKey: ["knowledge-search"] });
                            return saved.content;
                          }
                        : undefined
                    }
                    testId="knowledge-file-content"
                  />
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
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="font-label text-sm  text-muted-foreground">Collections</div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              reindex.mutate({ collections: (collections ?? []).map((entry) => entry.name) })
            }
            disabled={reindex.isPending || !collections?.length}
            className="font-label text-sm  text-muted-foreground"
          >
            <RefreshCw size={12} className={`mr-1 ${reindex.isPending ? "animate-spin" : ""}`} />
            {reindex.isPending ? "Indexing…" : "Reindex collections"}
          </Button>
          <Button
            data-testid="add-collection-button"
            size="sm"
            onClick={() => setCreating(true)}
            className="font-label text-sm  "
          >
            <Plus size={12} className="mr-1" />
            Add collection
          </Button>
        </div>
      </div>

      {(reindex.error || removeCollection.error) && (
        <p role="alert" className="mb-3 text-sm text-error">
          {(reindex.error || removeCollection.error)?.message}
        </p>
      )}
      {reindex.isSuccess && (
        <p role="status" className="mb-3 text-sm text-muted-foreground">
          Indexed {reindex.data.indexed} documents; updated {reindex.data.updated}.
        </p>
      )}
      {isLoading ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <Skeleton key={i} className="h-10 w-full bg-surface-highest" />
          ))}
        </div>
      ) : (collections ?? []).length === 0 ? (
        <EmptyState message="No collections" />
      ) : (
        <div className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-outline-variant hover:bg-transparent">
                <TableHead className="font-label text-sm  text-muted-foreground">Name</TableHead>
                <TableHead className="font-label text-sm  text-muted-foreground">Path</TableHead>
                <TableHead className="font-label text-sm  text-muted-foreground w-24">
                  Pattern
                </TableHead>
                <TableHead className="font-label text-sm  text-muted-foreground w-20">
                  Docs
                </TableHead>
                <TableHead className="font-label text-sm  text-muted-foreground w-36">
                  Last Modified
                </TableHead>
                <TableHead className="font-label text-sm  text-muted-foreground w-24">
                  Project
                </TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(collections ?? []).map((c) => (
                <TableRow
                  key={c.name}
                  data-testid="collection-row"
                  data-collection-name={c.name}
                  className="border-b border-outline-variant/50 hover:bg-surface-low"
                >
                  <TableCell className="font-label text-sm font-medium text-on-surface">
                    {c.name}
                  </TableCell>
                  <TableCell className="font-body text-sm text-muted-foreground truncate max-w-xs">
                    {c.path}
                  </TableCell>
                  <TableCell className="font-mono text-sm text-muted-foreground">
                    {c.pattern}
                  </TableCell>
                  <TableCell className="font-label text-sm text-on-surface text-center">
                    {c.documentCount}
                  </TableCell>
                  <TableCell className="font-label text-sm text-muted-foreground">
                    {c.lastModified ? new Date(c.lastModified).toLocaleDateString() : "\u2014"}
                  </TableCell>
                  <TableCell className="font-label text-sm text-muted-foreground">
                    {c.projectId ? c.projectId.slice(-6) : "\u2014"}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => reindex.mutate({ collections: [c.name] })}
                        disabled={reindex.isPending}
                        className="text-muted-foreground hover:text-primary transition-colors p-1"
                        title="Reindex"
                      >
                        <RefreshCw size={12} className={reindex.isPending ? "animate-spin" : ""} />
                      </button>
                      <button
                        type="button"
                        data-testid="collection-delete"
                        onClick={() => setDeleting(c.name)}
                        className="text-muted-foreground hover:text-error transition-colors p-1"
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
          title="Delete collection"
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
      <DialogContent className="bg-surface border-outline-variant max-w-md">
        <DialogHeader>
          <DialogTitle className="font-headline text-base  text-on-surface">
            Add collection
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-1.5">
            <Label className="font-label text-sm  text-muted-foreground">Name *</Label>
            <Input
              aria-label="Name"
              data-testid="collection-name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-docs"
              className="bg-background text-on-surface font-body text-sm"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-sm  text-muted-foreground">Path *</Label>
            <Input
              aria-label="Path"
              data-testid="collection-path-input"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/path/to/documents"
              className="bg-background text-on-surface font-body text-sm"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="font-label text-sm  text-muted-foreground">Pattern</Label>
              <Input
                aria-label="Pattern"
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder="**/*.md"
                className="bg-background text-on-surface font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="font-label text-sm  text-muted-foreground">Project ID</Label>
              <Input
                aria-label="Project ID"
                value={projId}
                onChange={(e) => setProjId(e.target.value)}
                placeholder="Optional"
                className="bg-background text-on-surface font-body text-sm"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="font-label text-sm text-muted-foreground"
            >
              Cancel
            </Button>
            <Button
              data-testid="collection-submit"
              type="submit"
              size="sm"
              disabled={addCollection.isPending || !name.trim() || !path.trim()}
              className="font-label text-sm "
            >
              {addCollection.isPending ? "Adding..." : "Add"}
            </Button>
          </DialogFooter>
          {addCollection.error && (
            <p role="alert" className="text-sm text-error">
              {addCollection.error.message}
            </p>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
