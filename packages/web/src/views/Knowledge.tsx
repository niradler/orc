import type { KbPassage, KnowledgeBase } from "@orc/core/kb";
import {
  BookOpen,
  Check,
  Copy,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderSync,
  Link2,
  Plus,
  Search,
  Settings2,
  Upload,
  X,
} from "lucide-react";
import { type DragEvent, Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router-dom";
import { confirmDocumentClose } from "@/components/DocumentWorkspace";
import { ErrorState } from "@/components/ErrorState";
import {
  CreateKbDialog,
  KbSettingsDialog,
  NewDocumentDialog,
  SourcesDialog,
} from "@/components/kb/KbDialogs";
import { KbDocumentPane, kbWorkspaceId, UsageTable } from "@/components/kb/KbDocumentPane";
import { useKbUploads } from "@/components/kb/useKbUploads";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ViewHeader } from "@/components/ViewHeader";
import {
  useKbDocument,
  useKbDocuments,
  useKbMaintenance,
  useKbSearch,
  useKbStatus,
  useKbUsage,
  useKnowledgeBases,
} from "@/hooks/useKnowledge";
import { useProjectScope } from "@/hooks/useProjectScope";
import { useProjects } from "@/hooks/useProjects";
import Memories from "@/views/Memories";

type Dialog = "create" | "settings" | "new-document" | "sources" | null;

export default function Knowledge({ projectId: savedProjectId }: { projectId: string }) {
  const projectId = useProjectScope(savedProjectId);
  const [searchParams] = useSearchParams();
  const { pathname, hash } = useLocation();

  // Links from the first Knowledge redesign pointed Wiki pages here; keep them working.
  if (searchParams.has("page")) {
    const next = new URLSearchParams(searchParams);
    next.delete("tab");
    return <Navigate replace to={{ pathname: "/knowledge/wiki", search: next.toString(), hash }} />;
  }
  return (
    <div data-testid="knowledge-base-view">
      {pathname.startsWith("/knowledge/memories") ? (
        <Memories projectId={savedProjectId} embedded />
      ) : (
        <KnowledgeBases
          key={projectId}
          projectId={projectId === "all" || projectId === "unassigned" ? undefined : projectId}
        />
      )}
    </div>
  );
}

/** «term» marks from the search snippet become highlights. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/«([^»]*)»/g);
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

function CopyCitation({ passage }: { passage: KbPassage }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      data-testid="kb-citation"
      title="Copy citation"
      className="inline-flex items-center gap-1 font-mono text-xs text-outline hover:text-primary"
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(passage.citation).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {passage.citation}
    </button>
  );
}

function KnowledgeBases({ projectId }: { projectId: string | undefined }) {
  const [params, setParams] = useSearchParams();
  const kbId = params.get("kb");
  const documentId = params.get("document");
  const folder = params.get("folder") ?? "";
  const label = params.get("label") ?? "";
  const query = params.get("q") ?? "";
  const searchAll = params.get("searchAll") === "1";
  const [queryInput, setQueryInput] = useState(query);
  useEffect(() => setQueryInput(query), [query]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [linksOpen, setLinksOpen] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [pendingHeading, setPendingHeading] = useState<string | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);

  const status = useKbStatus();
  const projects = useProjects();
  const bases = useKnowledgeBases(projectId);
  const kb = bases.data?.find((b) => b.id === kbId) ?? null;
  const listing = useKbDocuments(kb?.id ?? null, {
    ...(folder ? { folder } : {}),
    ...(label ? { label } : {}),
  });
  const doc = useKbDocument(documentId);
  const search = useKbSearch(
    query
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
      (previous) => {
        const next = new URLSearchParams(previous);
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
    // Choosing the open KB again leaves the document for its overview.
    if ((id === kbId && !documentId) || !leaveDocument()) return;
    update({ kb: id, document: null, folder: null, label: null });
    setFilesOpen(false);
  }
  function openDocument(id: string, heading?: string) {
    if (id !== documentId && !leaveDocument()) return;
    update({ document: id, q: null });
    setPendingHeading(heading ?? null);
    setFilesOpen(false);
  }

  // Default to the first visible KB; drop a KB that no longer exists (deleted elsewhere).
  useEffect(() => {
    if (!bases.data) return;
    if (kbId && !bases.data.some((b) => b.id === kbId) && !documentId) update({ kb: null }, true);
    else if (!kbId && bases.data[0]) update({ kb: bases.data[0].id }, true);
  });
  // Links and search results can open a document in another KB; follow it.
  useEffect(() => {
    if (doc.data && doc.data.kb_id !== kbId && bases.data?.some((b) => b.id === doc.data.kb_id))
      update({ kb: doc.data.kb_id, folder: null, label: null }, true);
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

  function upload(files: FileList | File[] | null) {
    if (!kb || !files?.length) return;
    uploads.add(kb.id, [...files], folder ? { folder } : {});
  }
  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    upload(e.dataTransfer.files);
  }

  const projectName = (id: string | null) =>
    id === null ? "Global" : (projects.data?.find((p) => p.id === id)?.name ?? "Project");
  const s = status.data;
  const meta = s
    ? `${s.documents} documents in ${s.knowledge_bases} knowledge bases · ${
        s.embedding.provider === "none"
          ? "keyword search (configure embeddings in Settings for semantic search)"
          : s.embedding.ready
            ? `hybrid search · ${s.embedding.model}`
            : `embeddings: ${s.embedding.detail ?? "not ready"}`
      }${s.jobs.queued + s.jobs.running ? ` · ${s.jobs.queued + s.jobs.running} jobs running` : ""}`
    : status.error
      ? "Knowledge status unavailable"
      : "Loading…";

  if (bases.error)
    return <ErrorState message={(bases.error as Error).message} onRetry={() => bases.refetch()} />;

  const sidebar = (
    <aside aria-label="Knowledge bases" data-testid="kb-sidebar" className="min-w-0 space-y-5 p-4">
      <section className="space-y-1">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Knowledge bases</h2>
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
        {bases.isLoading && <Skeleton className="h-10 w-full" />}
        <div data-testid="kb-list" className="space-y-0.5">
          {bases.data?.map((b) => (
            <button
              type="button"
              key={b.id}
              data-testid="kb-row"
              data-kb-name={b.name}
              aria-current={b.id === kbId ? "true" : undefined}
              className={`flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-surface-high ${b.id === kbId ? "bg-surface-high font-medium" : ""}`}
              onClick={() => selectKb(b.id)}
            >
              <BookOpen size={15} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{b.name}</span>
              {b.editable_by.includes("mcp") && (
                <span className="text-xs text-primary" title="Agents can change documents">
                  agents edit
                </span>
              )}
              {(b.project_id === null || !projectId) && (
                <span className="text-xs text-outline">{projectName(b.project_id)}</span>
              )}
              <span className="text-xs tabular-nums text-outline">{b.document_count}</span>
            </button>
          ))}
        </div>
      </section>
      {kb && listing.data && (
        <>
          {listing.data.folders.length > 0 && (
            <section className="space-y-0.5" data-testid="kb-folders">
              <h2 className="mb-1 text-sm font-medium">Folders</h2>
              <button
                type="button"
                className={`flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-surface-high ${folder ? "" : "bg-surface-high"}`}
                onClick={() => update({ folder: null })}
              >
                <FolderOpen size={14} />
                All documents
              </button>
              {listing.data.folders.map((f) => (
                <button
                  type="button"
                  key={f}
                  data-testid="kb-folder"
                  data-folder={f}
                  className={`flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-surface-high ${folder === f ? "bg-surface-high" : ""}`}
                  style={{ paddingLeft: `${0.5 + (f.split("/").length - 1) * 0.75}rem` }}
                  onClick={() => update({ folder: folder === f ? null : f })}
                >
                  <Folder size={14} className="shrink-0" />
                  <span className="truncate">{f.split("/").pop()}</span>
                </button>
              ))}
            </section>
          )}
          {listing.data.labels.length > 0 && (
            <section data-testid="kb-labels">
              <h2 className="mb-2 text-sm font-medium">Labels</h2>
              <div className="flex flex-wrap gap-1.5">
                {listing.data.labels.map((l) => (
                  <button
                    type="button"
                    key={l.label}
                    data-testid="kb-label-filter"
                    aria-pressed={label === l.label}
                    className={`rounded-full border px-2 py-0.5 text-xs ${label === l.label ? "border-primary bg-primary/10 text-primary" : "border-outline-variant text-outline hover:text-on-surface"}`}
                    onClick={() => update({ label: label === l.label ? null : l.label })}
                  >
                    {l.label} {l.count}
                  </button>
                ))}
              </div>
            </section>
          )}
          <section className="space-y-0.5" data-testid="kb-documents">
            <h2 className="mb-1 text-sm font-medium">
              Documents{folder || label ? " (filtered)" : ""}
            </h2>
            {listing.data.documents.length === 0 && (
              <p className="text-sm text-outline" data-testid="kb-documents-empty">
                {folder || label ? "No documents match." : "No documents yet."}
              </p>
            )}
            {listing.data.documents.map((d) => (
              <button
                type="button"
                key={d.id}
                data-testid="kb-document-row"
                data-document-title={d.title}
                aria-current={d.id === documentId ? "true" : undefined}
                className={`flex min-h-10 w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-high ${d.id === documentId ? "bg-surface-high" : ""}`}
                onClick={() => openDocument(d.id)}
              >
                <FileText size={15} className="mt-0.5 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{d.title}</span>
                  <span className="block truncate font-mono text-xs text-outline">{d.path}</span>
                </span>
                <span
                  className="shrink-0 text-xs text-outline"
                  title="Reads by agents, CLI, API and UI"
                >
                  {d.parse_state === "pending"
                    ? "parsing…"
                    : d.parse_state === "failed"
                      ? "failed"
                      : d.reads
                        ? `${d.reads} reads`
                        : ""}
                </span>
              </button>
            ))}
          </section>
        </>
      )}
    </aside>
  );

  return (
    <>
      <ViewHeader title="Knowledge bases" meta={<span role="status">{meta}</span>} />
      <section
        data-testid="knowledge-bases"
        className="min-w-0 border border-outline-variant bg-background"
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-outline-variant p-3">
          <Button
            variant="outline"
            className="lg:hidden"
            aria-expanded={filesOpen}
            aria-controls="kb-sidebar-panel"
            onClick={() => setFilesOpen(!filesOpen)}
          >
            <FolderOpen size={16} />
            Files
          </Button>
          <form
            className="flex min-w-0 flex-1 items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              update({ q: queryInput.trim() || null });
            }}
          >
            <Input
              aria-label="Search knowledge"
              data-testid="kb-search-input"
              value={queryInput}
              onChange={(e) => setQueryInput(e.target.value)}
              placeholder={kb && !searchAll ? `Search ${kb.name}` : "Search all knowledge bases"}
              className="min-w-0 flex-1 sm:max-w-md"
            />
            <Button
              type="submit"
              variant="outline"
              data-testid="kb-search-submit"
              aria-label="Search"
            >
              <Search size={16} />
            </Button>
            {kb && (
              <label className="hidden items-center gap-1 text-xs text-outline sm:flex">
                <input
                  type="checkbox"
                  data-testid="kb-search-all"
                  checked={searchAll}
                  onChange={(e) => update({ searchAll: e.target.checked ? "1" : null })}
                />
                All knowledge bases
              </label>
            )}
          </form>
          {kb && (
            <>
              <Button data-testid="kb-upload" onClick={() => uploadInput.current?.click()}>
                <Upload size={16} />
                Upload
              </Button>
              <input
                ref={uploadInput}
                type="file"
                multiple
                hidden
                data-testid="kb-upload-input"
                onChange={(e) => {
                  upload(e.target.files);
                  e.target.value = "";
                }}
              />
              <Button
                variant="ghost"
                data-testid="kb-new-document"
                onClick={() => setDialog("new-document")}
              >
                <FilePlus size={16} />
                New
              </Button>
              <Button variant="ghost" data-testid="kb-sources" onClick={() => setDialog("sources")}>
                <FolderSync size={16} />
                Folders
              </Button>
              <Button
                variant={linksOpen ? "secondary" : "ghost"}
                aria-pressed={linksOpen}
                data-testid="kb-details-toggle"
                onClick={() => setLinksOpen(!linksOpen)}
              >
                <Link2 size={16} />
                Details
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Knowledge base settings"
                data-testid="kb-settings"
                onClick={() => setDialog("settings")}
              >
                <Settings2 size={16} />
              </Button>
            </>
          )}
        </div>
        <UploadQueue uploads={uploads} onOpen={openDocument} />
        <div className="flex min-h-[60vh] min-w-0 flex-col lg:flex-row">
          <div
            id="kb-sidebar-panel"
            className={`${filesOpen ? "block" : "hidden"} w-full shrink-0 border-b border-outline-variant lg:block lg:w-72 lg:border-b-0 lg:border-r`}
          >
            {sidebar}
          </div>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: drop target; uploads also have a button */}
          <div
            className={`relative flex min-w-0 flex-1 ${dragging ? "outline-2 outline-dashed outline-primary" : ""}`}
            data-testid="kb-dropzone"
            onDragOver={(e) => {
              if (!kb) return;
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            {query ? (
              <SearchResults
                query={query}
                search={search}
                onOpen={openDocument}
                onClear={() => update({ q: null })}
              />
            ) : documentId ? (
              doc.data ? (
                <KbDocumentPane
                  key={doc.data.id}
                  doc={doc.data}
                  linksOpen={linksOpen}
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
            ) : kb ? (
              <KbOverview
                kb={kb}
                onUpload={() => uploadInput.current?.click()}
                onOpen={openDocument}
              />
            ) : bases.data?.length === 0 ? (
              <Centered testId="empty-state">
                <BookOpen size={28} className="text-primary" />
                <h2 className="text-xl font-medium">Build a knowledge base</h2>
                <p className="max-w-md text-outline">
                  Upload documents, write Markdown or register a folder. Agents search it with
                  citations through MCP, the CLI and the API, and you can see what they read.
                </p>
                <Button data-testid="kb-empty-create" onClick={() => setDialog("create")}>
                  <Plus size={16} />
                  New knowledge base
                </Button>
              </Centered>
            ) : null}
          </div>
        </div>
      </section>
      {dialog === "create" && (
        <CreateKbDialog
          open
          projectId={projectId}
          onClose={() => setDialog(null)}
          onCreated={(created) => {
            setDialog(null);
            update({ kb: created.id, document: null, folder: null, label: null });
          }}
        />
      )}
      {dialog === "settings" && kb && (
        <KbSettingsDialog
          kb={kb}
          onClose={() => setDialog(null)}
          onDeleted={() => {
            setDialog(null);
            update({ kb: null, document: null, folder: null, label: null });
          }}
        />
      )}
      {dialog === "new-document" && kb && (
        <NewDocumentDialog
          kb={kb}
          folder={folder}
          onClose={() => setDialog(null)}
          onCreated={(created) => {
            setDialog(null);
            update({ document: created.id, editorMode: "edit" });
          }}
        />
      )}
      {dialog === "sources" && kb && <SourcesDialog kb={kb} onClose={() => setDialog(null)} />}
    </>
  );
}

function Centered({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div
      data-testid={testId}
      className="mx-auto flex min-h-72 max-w-lg flex-1 flex-col items-start justify-center gap-4 p-6"
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
      className="min-w-0 flex-1 space-y-4 p-4 sm:p-6"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-lg font-medium">Results for “{query}”</h2>
        {result && (
          <span className="text-xs text-outline" data-testid="kb-search-mode">
            {result.mode} search ·{" "}
            {Math.round(Object.values(result.timings_ms).reduce((a, b) => a + b, 0))} ms
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
            <span className="block font-mono text-xs text-outline">
              {hit.kb_name} · {hit.path} · {hit.matched_by.join(" + ")}
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
              {p.heading_path.length > 0 && (
                <div className="text-xs text-outline">{p.heading_path.join(" › ")}</div>
              )}
              <p className="text-sm leading-relaxed">
                <Snippet text={p.snippet} />
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <CopyCitation passage={p} />
                {p.locator?.page && (
                  <span className="text-xs text-outline">page {p.locator.page}</span>
                )}
                {p.locator?.sheet && (
                  <span className="text-xs text-outline">sheet {p.locator.sheet}</span>
                )}
              </div>
            </div>
          ))}
        </article>
      ))}
    </section>
  );
}

function KbOverview({
  kb,
  onUpload,
  onOpen,
}: {
  kb: KnowledgeBase;
  onUpload: () => void;
  onOpen: (documentId: string) => void;
}) {
  const usage = useKbUsage(kb.id);
  const maintenance = useKbMaintenance(kb.id);
  const m = maintenance.data;
  return (
    <section data-testid="kb-overview" className="min-w-0 flex-1 space-y-6 p-4 sm:p-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-medium" data-testid="kb-overview-name">
          {kb.name}
        </h2>
        {kb.description && <p className="text-outline">{kb.description}</p>}
        <p className="text-sm text-outline">
          {kb.document_count} documents ·{" "}
          {kb.editable_by.length
            ? `editable from ${kb.editable_by.join(", ")}`
            : "read-only from every source"}
        </p>
      </div>
      {kb.document_count === 0 ? (
        <div className="rounded-md border border-dashed border-outline-variant p-6 text-center">
          <Upload size={24} className="mx-auto mb-2 text-primary" />
          <p className="mb-3 text-sm text-outline">
            Drop files here (PDF, Word, PowerPoint, Excel, HTML, Markdown, text) or
          </p>
          <Button onClick={onUpload} data-testid="kb-overview-upload">
            Choose files
          </Button>
        </div>
      ) : null}
      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <h3 className="mb-2 font-medium">Reads</h3>
          {usage.data ? (
            <UsageTable usage={usage.data} testId="kb-usage" />
          ) : (
            <p className="text-sm text-outline">Loading…</p>
          )}
        </div>
        <div data-testid="kb-maintenance" className="space-y-2 text-sm">
          <h3 className="font-medium">Needs attention</h3>
          {m && !m.stale.length && !m.failed.length && !m.unresolved_links.length && (
            <p className="text-outline">Nothing. Documents are parsed, indexed and linked.</p>
          )}
          {m?.failed.map((d) => (
            <button
              type="button"
              key={d.id}
              className="block text-left text-error hover:underline"
              onClick={() => onOpen(d.id)}
            >
              Parsing failed: {d.title}
            </button>
          ))}
          {m?.stale.map((d) => (
            <button
              type="button"
              key={d.id}
              className="block text-left text-warning hover:underline"
              onClick={() => onOpen(d.id)}
            >
              Stale summary: {d.title}
            </button>
          ))}
          {m?.unresolved_links.map((l) => (
            <button
              type="button"
              key={`${l.document_id}-${l.target}`}
              className="block text-left text-outline hover:underline"
              onClick={() => onOpen(l.document_id)}
            >
              [[{l.target}]] in {l.title} has no target
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function UploadQueue({
  uploads,
  onOpen,
}: {
  uploads: ReturnType<typeof useKbUploads>;
  onOpen: (documentId: string) => void;
}) {
  if (!uploads.uploads.length) return null;
  const active = uploads.uploads.some((u) => u.status === "uploading");
  return (
    <div
      data-testid="kb-upload-queue"
      className="space-y-1 border-b border-outline-variant p-3 text-sm"
    >
      <div className="flex items-center justify-between">
        <span className="font-medium">Uploads</span>
        {!active && (
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
      {uploads.uploads.map((u) => (
        <div
          key={u.id}
          data-testid="kb-upload-item"
          data-status={u.status}
          className="flex flex-wrap items-center gap-2"
        >
          <span className="min-w-0 flex-1 truncate">{u.file.name}</span>
          {u.status === "uploading" && (
            <span
              className="h-1.5 w-32 overflow-hidden rounded-full bg-surface-high"
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
          {u.status === "done" && u.document && (
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => u.document && onOpen(u.document.id)}
            >
              {u.document.parse_state === "pending" ? "Uploaded · parsing" : "Open"}
            </button>
          )}
          {u.status === "failed" && (
            <>
              <span role="alert" className="text-error">
                {u.error}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => uploads.retry(u.id)}
                data-testid="kb-upload-retry"
              >
                Retry
              </Button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function lastHeading(path: string[] | undefined): string | undefined {
  return path?.[path.length - 1];
}
