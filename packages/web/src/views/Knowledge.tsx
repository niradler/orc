import type { KbScope, KbSearchMode } from "@orc/core/kb";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ArrowLeft, ChevronRight, Menu, PanelRight, Plus, Settings } from "lucide-react";
import { type DragEvent, type ReactNode, useEffect, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { confirmDocumentClose } from "@/components/DocumentWorkspace";
import { ErrorState } from "@/components/ErrorState";
import { KbContextRail } from "@/components/kb/KbContextRail";
import { CreateKbDialog, KbSettingsDialog, NewDocumentDialog } from "@/components/kb/KbDialogs";
import { KbDocumentPane, kbWorkspaceId } from "@/components/kb/KbDocumentPane";
import { KbHome } from "@/components/kb/KbHome";
import { KbLabelsPage } from "@/components/kb/KbLabelsPage";
import { KbRail } from "@/components/kb/KbRail";
import { KbSearchPage } from "@/components/kb/KbSearchPage";
import type { KbUpload } from "@/components/kb/useKbUploads";
import { useKbUploads } from "@/components/kb/useKbUploads";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useInvalidateKb,
  useKbDocument,
  useKbDocuments,
  useKbSearch,
  useKnowledgeBases,
} from "@/hooks/useKnowledge";
import { useBreakpoint } from "@/hooks/useMediaQuery";
import { useProjectScope } from "@/hooks/useProjectScope";
import { useProjects } from "@/hooks/useProjects";
import { cn } from "@/lib/utils";
import Memories from "@/views/Memories";

type Dialog = "create" | "settings" | "new-document" | null;
type View = "home" | "search" | "labels";

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
        globalOnly={projectId === "unassigned"}
      />
    </div>
  );
}

function KnowledgeBases({
  projectId,
  globalOnly = false,
}: {
  projectId: string | undefined;
  globalOnly?: boolean;
}) {
  const [params, setParams] = useSearchParams();
  const { pathname } = useLocation();
  const kbId = params.get("kb");
  const documentId = params.get("document");
  const label = params.get("label") ?? "";
  const folder = params.get("folder") ?? "";
  const query = params.get("q") ?? "";
  const viewParam = params.get("view");
  const view: View =
    viewParam === "labels" || viewParam === "search" ? viewParam : query ? "search" : "home";
  const searchMode = (params.get("mode") as KbSearchMode | null) ?? "auto";
  const searchScope = (params.get("scope") as KbScope | null) ?? (projectId ? "default" : "all");
  const searchLabels = (params.get("labels") ?? "").split(",").filter(Boolean);
  const mediaType = params.get("media") ?? "";
  const [queryInput, setQueryInput] = useState(query);
  useEffect(() => setQueryInput(query), [query]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [navOpen, setNavOpen] = useState(false);
  const wide = useBreakpoint("lg");
  const extraWide = useBreakpoint("xl");
  const contextView = documentId ? "document" : view;
  const [contextOpen, setContextOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    const stored = window.localStorage.getItem(`kb-context:${contextView}`);
    return stored === "1";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(`kb-context:${contextView}`);
    setContextOpen(stored === "1");
  }, [contextView]);
  // The desktop rail remembers its state; the phone sheet opens on demand and never from a resize.
  const [contextSheetOpen, setContextSheetOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [pendingHeading, setPendingHeading] = useState<string | null>(null);
  const [droppedFile, setDroppedFile] = useState<File>();
  function closeNewDocument() {
    setDialog(null);
    setDroppedFile(undefined);
  }

  const projects = useProjects();
  const bases = useKnowledgeBases(projectId, globalOnly);
  const kb = bases.data?.find((base) => base.id === kbId) ?? null;
  const listing = useKbDocuments(kb?.id ?? null);
  const doc = useKbDocument(bases.data === undefined ? null : documentId);
  // The URL's KB resolves once the bases load (or defaults to the first one); searching before
  // then would send the query unscoped and again scoped.
  const scopeSettled = bases.data !== undefined && (kb !== null || bases.data.length === 0);
  const search = useKbSearch(
    query && scopeSettled
      ? {
          query,
          scope: searchScope,
          ...(kb ? { kb_ids: [kb.id] } : {}),
          ...(searchLabels.length ? { labels: searchLabels } : {}),
          ...(mediaType ? { media_types: [mediaType] } : {}),
          mode: searchMode,
          limit: 20,
        }
      : null,
    projectId,
  );
  const uploads = useKbUploads();
  const invalidate = useInvalidateKb();

  function update(changes: Record<string, string | null>, replace = false) {
    // setParams resolves against this page, so a late effect would pull the user back here.
    if (window.location.pathname !== pathname) return;
    setParams(
      () => {
        // Another workspace action may navigate before this render's effects run.
        const next = new URLSearchParams(window.location.search);
        for (const [key, value] of Object.entries(changes)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        return next;
      },
      { replace },
    );
  }
  const leaveDocument = () => !documentId || confirmDocumentClose(kbWorkspaceId(documentId));

  function setContext(open: boolean) {
    setContextOpen(open);
    if (typeof window !== "undefined")
      window.localStorage.setItem(`kb-context:${contextView}`, open ? "1" : "0");
  }
  function closeNav() {
    setNavOpen(false);
    // The dialog unmounts its own focused button; return focus to the trigger that opened it.
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>('[data-testid="kb-browser-open"]')?.focus(),
    );
  }
  function selectKb(id: string) {
    setNavOpen(false);
    setContextSheetOpen(false);
    if ((id === kbId && !documentId && !query) || !leaveDocument()) return;
    if (id !== kbId) uploads.clearFinished();
    update({ kb: id, document: null, label: null, folder: null, q: null, view: null });
  }
  function openDocument(id: string, heading?: string) {
    setNavOpen(false);
    setContextSheetOpen(false);
    if (id !== documentId && !leaveDocument()) return;
    update({ document: id, q: null, view: null });
    setPendingHeading(heading ?? null);
  }
  function openResult(id: string, heading?: string) {
    update({ document: id });
    setPendingHeading(heading ?? null);
  }
  function submitSearch() {
    setNavOpen(false);
    const next = queryInput.trim();
    if (!next) return update({ q: null, view: "search" });
    if (!leaveDocument()) return;
    update({ q: next, document: null, view: "search" });
  }
  function go(next: View) {
    if (!leaveDocument()) return;
    update({ view: next === "home" ? null : next, q: next === "search" ? query : null });
  }

  useEffect(() => {
    if (wide) setNavOpen(false);
  }, [wide]);

  // Default to the first visible KB; drop a KB that no longer exists (deleted elsewhere).
  useEffect(() => {
    if (!bases.data) return;
    if (documentId && doc.data && !bases.data.some((base) => base.id === doc.data?.kb_id)) {
      update(
        { kb: bases.data[0]?.id ?? null, document: null, label: null, q: null, view: null },
        true,
      );
    } else if (kbId && !bases.data.some((base) => base.id === kbId) && (!documentId || doc.error))
      update({ kb: null, document: null }, true);
    else if (!kbId && bases.data[0]) update({ kb: bases.data[0].id }, true);
  });
  // Links and search results can open a document in another KB; follow it.
  useEffect(() => {
    if (
      doc.data &&
      doc.data.kb_id !== kbId &&
      bases.data?.some((base) => base.id === doc.data?.kb_id)
    )
      update({ kb: doc.data.kb_id, label: null }, true);
  });
  useEffect(() => {
    if (!pendingHeading || !doc.data) return;
    const root = document.querySelector('[data-testid="kb-document"]');
    const target = [...(root?.querySelectorAll("h1,h2,h3,h4,h5,h6") ?? [])].find(
      (heading) => heading.textContent?.trim() === pendingHeading,
    );
    if (target) {
      target.scrollIntoView({ block: "start" });
      setPendingHeading(null);
    }
  });

  // One dropped file opens for review in the new document dialog; several upload together.
  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    const files = [...event.dataTransfer.files];
    if (!kb || files.length === 0) return;
    if (files.length > 1) uploads.add(kb.id, files);
    else {
      setDroppedFile(files[0]);
      setDialog("new-document");
    }
  }

  const projectName = (id: string | null) =>
    id === null
      ? "Global"
      : (projects.data?.find((project) => project.id === id)?.name ?? "Project");

  if (bases.error)
    return <ErrorState message={(bases.error as Error).message} onRetry={() => bases.refetch()} />;

  const docs = listing.data?.documents ?? [];
  const intake = {
    processing:
      docs.filter((doc) => doc.parse_state === "pending").length +
      uploads.uploads.filter((upload) => upload.status === "uploading").length,
    failed:
      docs.filter((doc) => doc.parse_state === "failed").length +
      uploads.uploads.filter((upload) => upload.status === "failed").length,
  };

  const content = documentId ? (
    doc.data && kb && doc.data.kb_id === kb.id ? (
      <KbDocumentPane
        key={doc.data.id}
        doc={doc.data}
        detailsOpen={extraWide ? contextOpen : contextSheetOpen}
        onDetailsOpenChange={(open) => (extraWide ? setContext(open) : setContextSheetOpen(open))}
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
  ) : view === "search" ? (
    <Scroll>
      <KbSearchPage
        query={query}
        queryInput={queryInput}
        onQueryInput={setQueryInput}
        onQuery={(next) => {
          if (next !== query && !leaveDocument()) return;
          update({ q: next || null, document: null, view: "search" });
        }}
        mode={searchMode}
        onMode={(mode) => update({ mode })}
        scope={searchScope}
        onScope={(scope) => update({ scope })}
        labels={searchLabels}
        onLabels={(labels) => update({ labels: labels.length ? labels.join(",") : null })}
        kbId={kb?.id ?? null}
        kbName={kb?.name ?? "all knowledge"}
        onKb={(id) => {
          if (id) update({ kb: id });
          else update({ kb: null });
        }}
        bases={bases.data ?? []}
        listing={listing.data}
        mediaType={mediaType}
        onMediaType={(type) => update({ media: type || null })}
        search={search}
        onOpen={openResult}
        onClear={() => update({ q: null, labels: null, media: null, view: null })}
      />
    </Scroll>
  ) : view === "labels" && kb ? (
    <Scroll>
      <KbLabelsPage
        kbId={kb.id}
        kbName={kb.name}
        listing={listing.data}
        onBack={() => go("home")}
        onOpenLabel={(next) => update({ view: null, label: next, document: null, q: null })}
      />
    </Scroll>
  ) : kb ? (
    <Scroll>
      <KbHome
        kb={kb}
        owner={projectName(kb.project_id)}
        listing={listing.data}
        label={label}
        folder={folder}
        intake={intake}
        onLabel={(next) => update({ label: next })}
        onFolder={(next) => update({ folder: next || null })}
        onOpen={openDocument}
        onNewDocument={() => setDialog("new-document")}
        onIntake={() => setDialog("new-document")}
        onLabels={() => go("labels")}
        onBulkDone={() => void invalidate()}
        onNavigate={go}
      />
    </Scroll>
  ) : bases.data?.length === 0 ? (
    <Centered testId="empty-state">
      <p className="text-sm text-outline">No knowledge bases configured</p>
      <Button data-testid="kb-empty-create" onClick={() => setDialog("create")}>
        <Plus size={16} />
        New knowledge base
      </Button>
    </Centered>
  ) : (
    <Centered>
      <Skeleton className="h-6 w-56" />
      <Skeleton className="h-24 w-full max-w-md" />
    </Centered>
  );

  const sidebar = (
    <KbRail
      bases={bases.data ?? []}
      kb={kb}
      projectName={projectName}
      listing={listing.data}
      projectId={projectId}
      folder={folder}
      label={label}
      queryInput={queryInput}
      onQueryInput={setQueryInput}
      onSearch={submitSearch}
      onSelectKb={selectKb}
      onCreateKb={() => setDialog("create")}
      onFolder={(next) => update({ folder: next || null, document: null, view: null })}
      onLabel={(next) => update({ label: next || null, document: null, view: null })}
      onLabels={() => go("labels")}
      onClose={navOpen && !wide ? closeNav : undefined}
    />
  );

  const context =
    kb && !documentId ? (
      <KbContextRail
        kb={kb}
        owner={projectName(kb.project_id)}
        onSettings={() => setDialog("settings")}
        onSearch={() => go("search")}
        onOpenDocument={openDocument}
      />
    ) : null;

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
          onDragOver={(event) => {
            if (!kb) return;
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-outline-variant px-3">
            <Button
              data-testid="kb-browser-open"
              variant="ghost"
              size="sm"
              aria-expanded={navOpen}
              aria-controls="kb-sidebar-panel"
              className="lg:hidden"
              onClick={() => setNavOpen(true)}
            >
              <Menu size={16} />
              Browse
            </Button>
            <nav
              aria-label="Knowledge location"
              className="flex min-w-0 flex-1 items-center gap-1 text-sm"
            >
              <button
                type="button"
                className="hidden shrink-0 text-outline hover:text-on-surface sm:block"
                onClick={() => go("home")}
              >
                Knowledge
              </button>
              {kb && (
                <>
                  <ChevronRight
                    size={13}
                    className="hidden shrink-0 text-outline sm:block"
                    aria-hidden
                  />
                  <button
                    type="button"
                    data-testid="kb-breadcrumb-kb"
                    className="hidden min-w-0 truncate text-outline hover:text-on-surface sm:block"
                    onClick={() => update({ document: null, q: null, view: null, label: null })}
                  >
                    {kb.name}
                  </button>
                </>
              )}
              {documentId && doc.data && (
                <>
                  <ChevronRight
                    size={13}
                    className="hidden shrink-0 text-outline sm:block"
                    aria-hidden
                  />
                  <span
                    className="min-w-0 truncate text-on-surface"
                    data-testid="kb-document-title"
                  >
                    {doc.data.title}
                  </span>
                </>
              )}
              {view === "search" && (
                <>
                  <ChevronRight size={13} className="shrink-0 text-outline" aria-hidden />
                  <span className="text-on-surface">Search</span>
                </>
              )}
              {view === "labels" && (
                <>
                  <ChevronRight size={13} className="shrink-0 text-outline" aria-hidden />
                  <span className="text-on-surface">Labels</span>
                </>
              )}
            </nav>
            {documentId && kb && (
              <Button
                size="icon"
                variant={(extraWide ? contextOpen : contextSheetOpen) ? "secondary" : "ghost"}
                aria-label="Document details"
                aria-pressed={extraWide ? contextOpen : contextSheetOpen}
                data-testid="kb-details-toggle"
                onClick={() =>
                  extraWide ? setContext(!contextOpen) : setContextSheetOpen(!contextSheetOpen)
                }
              >
                <PanelRight size={16} />
              </Button>
            )}
            {!documentId && kb && (
              <Button
                size="sm"
                variant="ghost"
                data-testid="kb-top-add"
                onClick={() => setDialog("new-document")}
              >
                <Plus size={14} />
                <span className="hidden sm:inline">Add</span>
              </Button>
            )}
            {!documentId && kb && (
              <Button
                size="icon"
                variant="ghost"
                aria-label="Knowledge settings"
                data-testid="kb-settings"
                onClick={() => setDialog("settings")}
              >
                <Settings size={16} />
              </Button>
            )}
            {!documentId && kb && (
              <Button
                size="icon"
                variant={(extraWide ? contextOpen : contextSheetOpen) ? "secondary" : "ghost"}
                aria-label="Knowledge details"
                aria-pressed={extraWide ? contextOpen : contextSheetOpen}
                data-testid="kb-context-toggle"
                onClick={() =>
                  extraWide ? setContext(!contextOpen) : setContextSheetOpen(!contextSheetOpen)
                }
              >
                <PanelRight size={16} />
              </Button>
            )}
          </div>
          {documentId && query && (
            <div className="flex shrink-0 items-center border-b border-outline-variant px-3 py-1">
              <Button
                variant="ghost"
                size="sm"
                data-testid="kb-search-back"
                className="min-w-0"
                onClick={() => leaveDocument() && update({ document: null, view: "search" })}
              >
                <ArrowLeft size={14} />
                <span className="truncate">Back to results for “{query}”</span>
              </Button>
            </div>
          )}
          <div className="flex min-h-0 min-w-0 flex-1">{content}</div>
          <UploadQueue uploads={uploads} onOpen={openDocument} />
        </div>
        {context && extraWide && contextOpen && (
          <div className="hidden w-[264px] shrink-0 border-l border-outline-variant xl:block">
            {context}
          </div>
        )}
        {context && !extraWide && (
          <Sheet open={contextSheetOpen} onOpenChange={setContextSheetOpen}>
            <SheetContent defaultWidth={320} resizeKey="kb-context" aria-describedby={undefined}>
              <SheetHeader className="py-3">
                <SheetTitle>Knowledge details</SheetTitle>
              </SheetHeader>
              <SheetBody className="p-0 sm:p-0">{context}</SheetBody>
            </SheetContent>
          </Sheet>
        )}
        {dialog === "create" && (
          <CreateKbDialog
            open
            projectId={projectId}
            onClose={() => setDialog(null)}
            onCreated={(created) => {
              setDialog(null);
              setNavOpen(false);
              update({ kb: created.id, document: null, label: null, q: null, view: null });
            }}
          />
        )}
        {dialog === "settings" && kb && (
          <KbSettingsDialog
            kb={kb}
            onClose={() => setDialog(null)}
            onDeleted={() => {
              setDialog(null);
              update({ kb: null, document: null, label: null, view: null });
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
              update({ document: created.id, editorMode: written ? null : "edit", view: null });
            }}
          />
        )}
      </div>
    </DialogPrimitive.Root>
  );
}

function Scroll({ children }: { children: ReactNode }) {
  return <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">{children}</div>;
}

function Centered({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div
      data-testid={testId}
      className="mx-auto flex w-full max-w-lg flex-1 flex-col items-start justify-center gap-4 p-6"
    >
      {children}
    </div>
  );
}

/** Floats over the content so it never pushes the page down; finished items stay until dismissed
 * or the user moves to another KB. */
function UploadQueue({
  uploads,
  onOpen,
}: {
  uploads: ReturnType<typeof useKbUploads>;
  onOpen: (documentId: string) => void;
}) {
  if (!uploads.uploads.length) return null;
  const finished = uploads.uploads.some((upload) => upload.status !== "uploading");
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
        {uploads.uploads.map((upload) => (
          <UploadItem
            key={upload.id}
            upload={upload}
            onOpen={onOpen}
            onRetry={() => uploads.retry(upload.id)}
          />
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
  upload: item,
  onOpen,
  onRetry,
}: {
  upload: KbUpload;
  onOpen: (documentId: string) => void;
  onRetry: () => void;
}) {
  // The upload response is a snapshot taken before background parsing; the KB listing is live.
  const listing = useKbDocuments(item.status === "done" ? item.kbId : null);
  const document =
    listing.data?.documents.find((doc) => doc.id === item.document?.id) ?? item.document;
  return (
    <div
      data-testid="kb-upload-item"
      data-status={item.status}
      data-parse-state={document?.parse_state}
      className="flex flex-wrap items-center gap-2"
    >
      <span className="min-w-0 flex-1 truncate">{item.file.name}</span>
      {item.status === "uploading" && (
        <span
          className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-high"
          role="progressbar"
          aria-label="Upload progress"
          aria-valuenow={Math.round(item.progress * 100)}
        >
          <span
            className="block h-full bg-primary"
            style={{ width: `${Math.round(item.progress * 100)}%` }}
          />
        </span>
      )}
      {item.status === "done" && document && (
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
      {item.status === "failed" && (
        <>
          <span role="alert" className="text-error">
            {item.error}
          </span>
          <Button size="sm" variant="ghost" onClick={onRetry} data-testid="kb-upload-retry">
            Retry
          </Button>
        </>
      )}
    </div>
  );
}
