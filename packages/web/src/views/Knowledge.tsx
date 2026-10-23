import type { KnowledgeBase } from "@orc/core/kb";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ArrowLeft, BookOpen, ChevronRight, FileText, Menu, Plus, Search, X } from "lucide-react";
import { type DragEvent, Fragment, type ReactNode, useEffect, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { confirmDocumentClose } from "@/components/DocumentWorkspace";
import { ErrorState } from "@/components/ErrorState";
import { CreateKbDialog, KbSettingsDialog, NewDocumentDialog } from "@/components/kb/KbDialogs";
import { KbDocumentPane, kbWorkspaceId } from "@/components/kb/KbDocumentPane";
import { KbHome } from "@/components/kb/KbHome";
import type { KbUpload } from "@/components/kb/useKbUploads";
import { useKbUploads } from "@/components/kb/useKbUploads";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useKbDocument,
  useKbDocuments,
  useKbSearch,
  useKbStatus,
  useKnowledgeBases,
} from "@/hooks/useKnowledge";
import { useBreakpoint } from "@/hooks/useMediaQuery";
import { useProjectScope } from "@/hooks/useProjectScope";
import { useProjects } from "@/hooks/useProjects";
import { cn } from "@/lib/utils";
import Memories from "@/views/Memories";

type Dialog = "create" | "settings" | "new-document" | null;

export default function Knowledge({ projectId: savedProjectId }: { projectId: string }) {
  const projectId = useProjectScope(savedProjectId);
  const { pathname } = useLocation();
  if (pathname.startsWith("/knowledge/memories"))
    return (
      <div data-testid="knowledge-base-view">
        <Memories projectId={savedProjectId} embedded />
      </div>
    );
  return (
    <div data-testid="knowledge-base-view" className="flex min-h-0 min-w-0 flex-1">
      <KnowledgeBases
        key={projectId}
        projectId={projectId === "all" || projectId === "unassigned" ? undefined : projectId}
      />
    </div>
  );
}

/** Markdown syntax in a search snippet becomes the plain text a reader sees. */
function plainText(markdown: string): string {
  return markdown
    .replace(/```[\w-]*/g, " ")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/(^|\n)\s*(?:>\s*)+/g, "$1")
    .replace(/(^|\n)\s*(?:[-*+]|\d+[.)])\s+/g, "$1")
    .replace(/\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?/g, " ")
    .replace(/(^|\s)(?:\*{3,}|_{3,})(?=\s|$)/g, "$1")
    .replace(/`/g, "")
    .replace(/(^|[\s(«])[*_~]+(?=\S)/g, "$1")
    .replace(/(\S)[*_~]+(?=$|[\s).,;:!?»])/g, "$1")
    .replace(/\s*\|[\s|]*/g, " · ")
    .replace(/\s+/g, " ")
    .replace(/^ · | · $/g, "")
    .trim();
}

/** «term» marks from the search snippet become highlights. */
function Snippet({ text }: { text: string }) {
  const parts = plainText(text).split(/«([^»]*)»/g);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional
          <mark key={i} className="rounded-sm bg-primary/20 px-0.5 text-on-surface">
            {part}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

function KnowledgeBases({ projectId }: { projectId: string | undefined }) {
  const [params, setParams] = useSearchParams();
  const kbId = params.get("kb");
  const documentId = params.get("document");
  const label = params.get("label") ?? "";
  const query = params.get("q") ?? "";
  const searchAll = params.get("searchAll") === "1";
  const [queryInput, setQueryInput] = useState(query);
  useEffect(() => setQueryInput(query), [query]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [navOpen, setNavOpen] = useState(false);
  const wide = useBreakpoint("lg");
  // The details column fits beside a readable document only on wide screens.
  const [detailsOpen, setDetailsOpen] = useState(
    () => typeof window !== "undefined" && window.innerWidth >= 1600,
  );
  const [dragging, setDragging] = useState(false);
  const [pendingHeading, setPendingHeading] = useState<string | null>(null);
  const [droppedFile, setDroppedFile] = useState<File>();
  function closeNewDocument() {
    setDialog(null);
    setDroppedFile(undefined);
  }

  const projects = useProjects();
  const bases = useKnowledgeBases(projectId);
  const kb = bases.data?.find((b) => b.id === kbId) ?? null;
  const listing = useKbDocuments(kb?.id ?? null);
  const doc = useKbDocument(documentId);
  // The URL's KB resolves once the bases load (or defaults to the first one); searching before
  // then would send the query unscoped and again scoped.
  const scopeSettled = bases.data !== undefined && (kb !== null || bases.data.length === 0);
  const search = useKbSearch(
    query && scopeSettled
      ? {
          query,
          ...(kb && !searchAll ? { kb_ids: [kb.id] } : {}),
          scope: projectId ? "default" : "all",
          limit: 20,
        }
      : null,
    projectId,
  );
  const uploads = useKbUploads();

  function update(changes: Record<string, string | null>, replace = false) {
    setParams(
      () => {
        // Another workspace action may navigate before this render's effects run.
        const next = new URLSearchParams(window.location.search);
        for (const [k, v] of Object.entries(changes)) {
          if (v) next.set(k, v);
          else next.delete(k);
        }
        return next;
      },
      { replace },
    );
  }
  const leaveDocument = () => !documentId || confirmDocumentClose(kbWorkspaceId(documentId));

  function selectKb(id: string | null) {
    setNavOpen(false);
    // Choosing the open KB again leaves the document for its home page.
    if ((id === kbId && !documentId && !query) || !leaveDocument()) return;
    // Finished uploads belong to the KB being left.
    if (id !== kbId) uploads.clearFinished();
    update({ kb: id, document: null, label: null, q: null });
  }
  function openDocument(id: string, heading?: string) {
    setNavOpen(false);
    if (id !== documentId && !leaveDocument()) return;
    update({ document: id, q: null });
    setPendingHeading(heading ?? null);
  }
  /** A result opens with the query kept, so going back shows the same results. */
  function openResult(id: string, heading?: string) {
    update({ document: id });
    setPendingHeading(heading ?? null);
  }
  function submitSearch() {
    setNavOpen(false);
    const next = queryInput.trim();
    if (!next) return update({ q: null });
    if (!leaveDocument()) return;
    update({ q: next, document: null });
  }

  useEffect(() => {
    if (wide) setNavOpen(false);
  }, [wide]);

  // Default to the first visible KB; drop a KB that no longer exists (deleted elsewhere).
  useEffect(() => {
    if (!bases.data) return;
    if (kbId && !bases.data.some((b) => b.id === kbId) && !documentId) update({ kb: null }, true);
    else if (!kbId && bases.data[0]) update({ kb: bases.data[0].id }, true);
  });
  // Links and search results can open a document in another KB; follow it.
  useEffect(() => {
    if (doc.data && doc.data.kb_id !== kbId && bases.data?.some((b) => b.id === doc.data.kb_id))
      update({ kb: doc.data.kb_id, label: null }, true);
  });
  useEffect(() => {
    if (!pendingHeading || !doc.data) return;
    const root = document.querySelector('[data-testid="kb-document"]');
    const target = [...(root?.querySelectorAll("h1,h2,h3,h4,h5,h6") ?? [])].find(
      (h) => h.textContent?.trim() === pendingHeading,
    );
    if (target) {
      target.scrollIntoView({ block: "start" });
      setPendingHeading(null);
    }
  });

  // One dropped file opens for review in the new document dialog; several upload together.
  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    const files = [...e.dataTransfer.files];
    if (!kb || files.length === 0) return;
    if (files.length > 1) uploads.add(kb.id, files);
    else {
      setDroppedFile(files[0]);
      setDialog("new-document");
    }
  }

  const projectName = (id: string | null) =>
    id === null ? "Global" : (projects.data?.find((p) => p.id === id)?.name ?? "Project");

  if (bases.error)
    return <ErrorState message={(bases.error as Error).message} onRetry={() => bases.refetch()} />;

  const content = documentId ? (
    doc.data && kb ? (
      <KbDocumentPane
        key={doc.data.id}
        kb={kb}
        doc={doc.data}
        detailsOpen={detailsOpen}
        onDetailsOpenChange={setDetailsOpen}
        onHome={() => selectKb(kb.id)}
        onOpen={openDocument}
        onDeleted={() => update({ document: null })}
        onReplaceFile={(file) =>
          doc.data &&
          uploads.add(doc.data.kb_id, [file], {
            replace: { document_id: doc.data.id, expected_revision: doc.data.revision },
          })
        }
      />
    ) : doc.error ? (
      <Centered>
        <p role="alert" data-testid="kb-document-error" className="text-sm text-error">
          {(doc.error as Error).message}
        </p>
        <Button variant="outline" onClick={() => update({ document: null })}>
          Back
        </Button>
      </Centered>
    ) : (
      <Centered>
        <p role="status" className="text-sm text-outline">
          Loading document…
        </p>
      </Centered>
    )
  ) : query ? (
    <Scroll>
      <SearchResults
        query={query}
        search={search}
        onOpen={openResult}
        onClear={() => update({ q: null })}
      />
    </Scroll>
  ) : kb ? (
    <Scroll>
      <KbHome
        kb={kb}
        owner={projectName(kb.project_id)}
        listing={listing.data}
        label={label}
        onLabel={(next) => update({ label: next })}
        onOpen={openDocument}
        onNewDocument={() => setDialog("new-document")}
        onSettings={() => setDialog("settings")}
      />
    </Scroll>
  ) : bases.data?.length === 0 ? (
    <Centered testId="empty-state">
      <BookOpen size={28} className="text-primary" />
      <h2 className="text-xl font-medium">Build a knowledge base</h2>
      <p className="max-w-md text-outline">
        Upload documents, write Markdown or sync a folder. Agents search it with citations through
        MCP, the CLI and the API, and you can see what they read.
      </p>
      <Button data-testid="kb-empty-create" onClick={() => setDialog("create")}>
        <Plus size={16} />
        New knowledge base
      </Button>
    </Centered>
  ) : null;

  const sidebar = (
    <nav
      id="kb-sidebar-panel"
      aria-label="Knowledge bases"
      data-testid="kb-sidebar"
      className="flex h-full min-h-0 flex-col border-outline-variant bg-background lg:w-72 lg:shrink-0 lg:border-r"
    >
      <form
        className="flex shrink-0 items-center gap-1.5 border-b border-outline-variant p-3"
        onSubmit={(e) => {
          e.preventDefault();
          submitSearch();
        }}
      >
        <Input
          aria-label="Search knowledge"
          data-testid="kb-search-input"
          value={queryInput}
          onChange={(e) => setQueryInput(e.target.value)}
          placeholder={kb && !searchAll ? `Search ${kb.name}` : "Search everything"}
          className="h-9 min-w-0 flex-1"
        />
        <Button
          type="submit"
          size="icon"
          variant="ghost"
          data-testid="kb-search-submit"
          aria-label="Search"
        >
          <Search size={16} />
        </Button>
        {navOpen && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            data-testid="kb-browser-close"
            aria-label="Close knowledge browser"
            onClick={() => setNavOpen(false)}
          >
            <X size={16} />
          </Button>
        )}
      </form>
      {kb && (
        <label className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-3 py-2 text-xs text-outline">
          <input
            type="checkbox"
            data-testid="kb-search-all"
            checked={searchAll}
            onChange={(e) => update({ searchAll: e.target.checked ? "1" : null })}
          />
          Search all knowledge bases
        </label>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="flex items-center justify-between px-2 pb-1">
          <h2 className="text-sm font-medium text-outline">Knowledge bases</h2>
          <Button
            size="icon"
            variant="ghost"
            aria-label="New knowledge base"
            data-testid="kb-create"
            onClick={() => setDialog("create")}
          >
            <Plus size={16} />
          </Button>
        </div>
        {bases.isLoading && <Skeleton className="mx-2 h-9" />}
        <KbTree
          bases={bases.data ?? []}
          projectName={projectName}
          kbId={kbId}
          documentId={documentId}
          documents={listing.data?.documents ?? []}
          onSelectKb={selectKb}
          onOpenDocument={openDocument}
        />
      </div>
      <KbStatusLine />
    </nav>
  );

  return (
    <DialogPrimitive.Root open={navOpen && !wide} onOpenChange={setNavOpen}>
      <div data-testid="knowledge-bases" className="relative flex min-h-0 min-w-0 flex-1">
        <h1 data-testid="view-title" className="sr-only">
          Knowledge bases
        </h1>
        {wide && sidebar}
        {!wide && (
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70" />
            <DialogPrimitive.Content
              data-testid="kb-mobile-browser"
              className="viewport-sheet fixed inset-x-0 z-50 bg-background"
            >
              <DialogPrimitive.Title className="sr-only">Browse knowledge</DialogPrimitive.Title>
              <DialogPrimitive.Description className="sr-only">
                Search knowledge bases and choose a document
              </DialogPrimitive.Description>
              {sidebar}
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        )}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: drop target; uploads also have a button */}
        <div
          data-testid="kb-dropzone"
          className={cn(
            "relative flex min-h-0 min-w-0 flex-1 flex-col",
            dragging && "outline-2 -outline-offset-4 outline-dashed outline-primary",
          )}
          onDragOver={(e) => {
            if (!kb) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-3 py-2 lg:hidden">
            <DialogPrimitive.Trigger asChild>
              <Button
                data-testid="kb-browser-open"
                variant="ghost"
                size="sm"
                aria-expanded={navOpen}
                aria-controls="kb-sidebar-panel"
                onClick={() => setNavOpen(true)}
              >
                <Menu size={16} />
                Browse
              </Button>
            </DialogPrimitive.Trigger>
            {kb && <span className="min-w-0 truncate text-sm text-outline">{kb.name}</span>}
          </div>
          {documentId && query && (
            <div className="flex shrink-0 items-center border-b border-outline-variant px-3 py-1">
              <Button
                variant="ghost"
                size="sm"
                data-testid="kb-search-back"
                className="min-w-0"
                onClick={() => leaveDocument() && update({ document: null })}
              >
                <ArrowLeft size={14} />
                <span className="truncate">Back to results for “{query}”</span>
              </Button>
            </div>
          )}
          <div className="flex min-h-0 min-w-0 flex-1">{content}</div>
          <UploadQueue uploads={uploads} onOpen={openDocument} />
        </div>
        {dialog === "create" && (
          <CreateKbDialog
            open
            projectId={projectId}
            onClose={() => setDialog(null)}
            onCreated={(created) => {
              setDialog(null);
              setNavOpen(false);
              update({ kb: created.id, document: null, label: null, q: null });
            }}
          />
        )}
        {dialog === "settings" && kb && (
          <KbSettingsDialog
            kb={kb}
            onClose={() => setDialog(null)}
            onDeleted={() => {
              setDialog(null);
              update({ kb: null, document: null, label: null });
            }}
          />
        )}
        {dialog === "new-document" && kb && (
          <NewDocumentDialog
            kb={kb}
            initialFile={droppedFile}
            onClose={closeNewDocument}
            onUploadMany={(files) => {
              closeNewDocument();
              uploads.add(kb.id, files);
            }}
            onCreated={(created, written) => {
              closeNewDocument();
              // An empty document opens ready to write; a pasted one opens to read.
              update({ document: created.id, editorMode: written ? null : "edit" });
            }}
          />
        )}
      </div>
    </DialogPrimitive.Root>
  );
}

/** Knowledge bases grouped by owner; the open one lists its documents beneath it. */
function KbTree({
  bases,
  projectName,
  kbId,
  documentId,
  documents,
  onSelectKb,
  onOpenDocument,
}: {
  bases: KnowledgeBase[];
  projectName: (id: string | null) => string;
  kbId: string | null;
  documentId: string | null;
  documents: { id: string; title: string }[];
  onSelectKb: (id: string) => void;
  onOpenDocument: (id: string) => void;
}) {
  // Clicking the open knowledge base again folds its document list; opening a document unfolds it.
  const [folded, setFolded] = useState<string | null>(null);
  useEffect(() => {
    if (documentId) setFolded(null);
  }, [documentId]);
  const groups = new Map<string, KnowledgeBase[]>();
  for (const b of bases) {
    const name = projectName(b.project_id);
    groups.set(name, [...(groups.get(name) ?? []), b]);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) =>
    a === "Global" ? -1 : b === "Global" ? 1 : a.localeCompare(b),
  );
  return (
    <div data-testid="kb-list" className="space-y-3">
      {ordered.map(([group, list]) => (
        <section key={group} aria-label={group}>
          {ordered.length > 1 && (
            <h3 className="truncate px-2 pb-0.5 pt-1 text-xs text-outline">{group}</h3>
          )}
          <ul className="space-y-0.5">
            {list.map((b) => {
              const open = b.id === kbId;
              const listed = open && folded !== b.id && documents.length > 0;
              return (
                <li key={b.id}>
                  <button
                    type="button"
                    data-testid="kb-row"
                    data-kb-name={b.name}
                    aria-current={open && !documentId ? "page" : undefined}
                    aria-expanded={listed}
                    className={cn(
                      "flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-surface-high",
                      open && "font-medium",
                      open && !documentId && "bg-surface-high",
                    )}
                    onClick={() => {
                      if (open) setFolded((f) => (f === b.id ? null : b.id));
                      onSelectKb(b.id);
                    }}
                  >
                    <ChevronRight
                      size={14}
                      aria-hidden
                      className={cn(
                        "-mr-1 shrink-0 text-outline transition-transform motion-reduce:transition-none",
                        listed && "rotate-90",
                        b.document_count === 0 && "invisible",
                      )}
                    />
                    <BookOpen size={15} className="shrink-0 text-outline" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{b.name}</span>
                    <span className="text-xs font-normal tabular-nums text-outline">
                      {b.document_count}
                    </span>
                  </button>
                  {listed && (
                    <ul className="ml-4 mt-0.5 space-y-0.5 border-l border-outline-variant pl-2">
                      {documents.map((d) => (
                        <li key={d.id}>
                          <button
                            type="button"
                            data-testid="kb-nav-document"
                            data-document-title={d.title}
                            aria-current={d.id === documentId ? "page" : undefined}
                            className={cn(
                              "flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-surface-high",
                              d.id === documentId
                                ? "bg-surface-high text-on-surface"
                                : "text-outline",
                            )}
                            onClick={() => onOpenDocument(d.id)}
                          >
                            <FileText size={14} className="shrink-0" aria-hidden />
                            <span className="min-w-0 flex-1 truncate">{d.title}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** The search mode and background work, at the foot of the navigation. Each KB row shows its
 * own document count. */
function KbStatusLine() {
  const status = useKbStatus();
  const s = status.data;
  const searchMode = !s
    ? null
    : s.embedding.provider === "none"
      ? {
          text: "Keyword search only",
          title: "Configure embeddings in Settings to also search by meaning",
        }
      : s.embedding.ready
        ? { text: "Hybrid search", title: s.embedding.model ?? undefined }
        : { text: "Embeddings not ready", title: s.embedding.detail ?? "" };
  const jobs = s ? s.jobs.queued + s.jobs.running : 0;
  return (
    <p
      role="status"
      data-testid="kb-status"
      className="shrink-0 border-t border-outline-variant px-4 py-2 text-xs text-outline"
    >
      {s ? (
        <>
          <span title={searchMode?.title}>{searchMode?.text}</span>
          {jobs ? ` · ${jobs} processing` : ""}
        </>
      ) : status.error ? (
        "Knowledge status unavailable"
      ) : (
        "Loading…"
      )}
    </p>
  );
}

function Scroll({ children }: { children: ReactNode }) {
  return <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">{children}</div>;
}

function Centered({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div
      data-testid={testId}
      className="mx-auto flex max-w-lg flex-1 flex-col items-start justify-center gap-4 p-6"
    >
      {children}
    </div>
  );
}

function SearchResults({
  query,
  search,
  onOpen,
  onClear,
}: {
  query: string;
  search: ReturnType<typeof useKbSearch>;
  onOpen: (documentId: string, heading?: string) => void;
  onClear: () => void;
}) {
  const result = search.data;
  return (
    <section
      data-testid="kb-search-results"
      aria-label="Search results"
      className="w-full min-w-0 space-y-4 p-4 sm:p-8"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-lg font-medium">Results for “{query}”</h2>
        {result && result.hits.length > 0 && (
          <span className="text-xs text-outline" data-testid="kb-search-count">
            {result.hits.length} {result.hits.length === 1 ? "result" : "results"}
          </span>
        )}
        <Button variant="ghost" size="sm" onClick={onClear} data-testid="kb-search-clear">
          <X size={14} />
          Clear
        </Button>
      </div>
      {result?.degraded && (
        <p role="status" className="text-sm text-warning">
          {result.degraded}
        </p>
      )}
      {search.isLoading && <p className="text-sm text-outline">Searching…</p>}
      {search.error && (
        <p role="alert" className="text-sm text-error">
          {(search.error as Error).message}
        </p>
      )}
      {result?.hits.length === 0 && (
        <p className="text-sm text-outline" data-testid="kb-search-empty">
          Nothing matched. Try other words or search all knowledge bases.
        </p>
      )}
      {result?.hits.map((hit) => (
        <article
          key={hit.document_id}
          data-testid="kb-search-result"
          className="space-y-2 border-b border-outline-variant pb-4"
        >
          <button
            type="button"
            className="block text-left"
            onClick={() => onOpen(hit.document_id, lastHeading(hit.passages[0]?.heading_path))}
          >
            <span className="block font-medium text-primary hover:underline">{hit.title}</span>
            <span className="block break-all text-xs text-outline">
              {hit.kb_name} · {hit.path}
            </span>
          </button>
          {hit.labels.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {hit.labels.map((l) => (
                <Badge key={l} variant="secondary">
                  {l}
                </Badge>
              ))}
            </div>
          )}
          {hit.passages.map((p) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the title button is the keyboard path
            // biome-ignore lint/a11y/noStaticElementInteractions: passage is a secondary click target
            <div
              key={p.chunk_id}
              data-testid="kb-search-passage"
              className="cursor-pointer space-y-1 rounded-md p-2 hover:bg-surface-high"
              onClick={() => onOpen(hit.document_id, lastHeading(p.heading_path))}
            >
              {(p.heading_path.length > 0 || p.locator?.page || p.locator?.sheet) && (
                <div className="text-xs text-outline">
                  {[
                    ...p.heading_path.map(plainText),
                    ...(p.locator?.page ? [`page ${p.locator.page}`] : []),
                    ...(p.locator?.sheet ? [`sheet ${p.locator.sheet}`] : []),
                  ].join(" › ")}
                </div>
              )}
              <p className="text-sm leading-relaxed">
                <Snippet text={p.snippet} />
              </p>
            </div>
          ))}
        </article>
      ))}
    </section>
  );
}

/** Floats over the content so it never pushes the page down; finished items stay until dismissed
 * or the user moves to another knowledge base. */
function UploadQueue({
  uploads,
  onOpen,
}: {
  uploads: ReturnType<typeof useKbUploads>;
  onOpen: (documentId: string) => void;
}) {
  if (!uploads.uploads.length) return null;
  const finished = uploads.uploads.some((u) => u.status !== "uploading");
  return (
    <section
      data-testid="kb-upload-queue"
      aria-label="Uploads"
      className="absolute bottom-4 right-4 z-10 flex max-h-72 w-80 max-w-[calc(100%-2rem)] flex-col rounded-lg border border-outline-variant bg-surface text-sm shadow-lg"
    >
      <div className="flex shrink-0 items-center justify-between px-3 py-1.5">
        <span className="font-medium">Uploads</span>
        {finished && (
          <Button
            size="sm"
            variant="ghost"
            onClick={uploads.clearFinished}
            data-testid="kb-upload-clear"
          >
            Dismiss
          </Button>
        )}
      </div>
      <div className="min-h-0 space-y-1 overflow-y-auto px-3 pb-2">
        {uploads.uploads.map((u) => (
          <UploadItem key={u.id} upload={u} onOpen={onOpen} onRetry={() => uploads.retry(u.id)} />
        ))}
      </div>
    </section>
  );
}

const PARSE_LABEL = {
  pending: "Parsing…",
  ok: "Open",
  partial: "Open · partly parsed",
  failed: "Parse failed",
};

function UploadItem({
  upload: u,
  onOpen,
  onRetry,
}: {
  upload: KbUpload;
  onOpen: (documentId: string) => void;
  onRetry: () => void;
}) {
  // The upload response is a snapshot taken before background parsing; the KB listing is live.
  const listing = useKbDocuments(u.status === "done" ? u.kbId : null);
  const document = listing.data?.documents.find((d) => d.id === u.document?.id) ?? u.document;
  return (
    <div
      data-testid="kb-upload-item"
      data-status={u.status}
      data-parse-state={document?.parse_state}
      className="flex flex-wrap items-center gap-2"
    >
      <span className="min-w-0 flex-1 truncate">{u.file.name}</span>
      {u.status === "uploading" && (
        <span
          className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-high"
          role="progressbar"
          aria-label="Upload progress"
          aria-valuenow={Math.round(u.progress * 100)}
        >
          <span
            className="block h-full bg-primary"
            style={{ width: `${Math.round(u.progress * 100)}%` }}
          />
        </span>
      )}
      {u.status === "done" && document && (
        <button
          type="button"
          className={cn(
            "hover:underline",
            document.parse_state === "failed" ? "text-error" : "text-primary",
          )}
          onClick={() => onOpen(document.id)}
        >
          {PARSE_LABEL[document.parse_state]}
        </button>
      )}
      {u.status === "failed" && (
        <>
          <span role="alert" className="text-error">
            {u.error}
          </span>
          <Button size="sm" variant="ghost" onClick={onRetry} data-testid="kb-upload-retry">
            Retry
          </Button>
        </>
      )}
    </div>
  );
}

function lastHeading(path: string[] | undefined): string | undefined {
  return path?.[path.length - 1];
}
