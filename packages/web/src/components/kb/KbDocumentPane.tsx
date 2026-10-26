import {
  KB_CALL_SOURCES,
  KB_READ_KINDS,
  type KbDocumentWithContent,
  type KbUsageStats,
  type KnowledgeBase,
} from "@orc/core/kb";
import * as Popover from "@radix-ui/react-popover";
import {
  AlertTriangle,
  ChevronRight,
  Download,
  FileDown,
  FileUp,
  MoreHorizontal,
  PanelRight,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "@/api/client";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DocumentWorkspace } from "@/components/DocumentWorkspace";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  useInvalidateKb,
  useKbComments,
  useKbDocumentUsage,
  useKbRevisions,
} from "@/hooks/useKnowledge";
import { useBreakpoint } from "@/hooks/useMediaQuery";
import { saveFile } from "@/lib/save-file";
import { cn, formatBytes } from "@/lib/utils";
import { wikiLinkKey } from "@/lib/wiki-links";
import { KbComments } from "./KbComments";
import { DocumentPropertiesDialog } from "./KbDialogs";
import { StateDot } from "./KbSetupRow";

type RenameBase = { title: string; backlinks: KbDocumentWithContent["backlinks"] };

export const kbWorkspaceId = (documentId: string) => `kb:${documentId}`;

const STATE_LABEL: Record<string, string> = {
  pending: "Processing",
  partial: "Partially parsed",
  failed: "Failed",
  lexical_ready: "Keyword search ready",
  semantic_pending: "Embedding",
  semantic_ready: "Semantic search ready",
};

/** Arrow keys, Home and End move between the items of an open menu, as in a native menu. */
function moveMenuFocus(event: KeyboardEvent<HTMLElement>) {
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'),
  ];
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next =
    event.key === "ArrowDown"
      ? (at + 1) % items.length
      : event.key === "ArrowUp"
        ? (at - 1 + items.length) % items.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : null;
  if (next === null || !items.length) return;
  event.preventDefault();
  items[next]?.focus();
}

export function UsageTable({ usage, testId }: { usage: KbUsageStats; testId: string }) {
  return (
    <div data-testid={testId} className="space-y-2">
      <div className="text-sm">
        <span data-testid={`${testId}-reads`} className="font-medium">
          {usage.reads}
        </span>{" "}
        reads · {usage.exposures} search appearances · {usage.distinct_sessions} sessions
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-outline">
            <th className="py-1 text-left font-normal">Source</th>
            {KB_READ_KINDS.map((k) => (
              <th key={k} className="py-1 text-right font-normal">
                {k === "search_hit" ? "listed" : k}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {KB_CALL_SOURCES.map((source) => (
            <tr
              key={source}
              data-testid={`${testId}-${source}`}
              className="border-t border-outline-variant/50"
            >
              <td className="py-1 uppercase">{source}</td>
              {KB_READ_KINDS.map((k) => (
                <td key={k} className="py-1 text-right tabular-nums">
                  {usage.totals[source][k]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="text-xs text-outline">
        Last 7 days {usage.window.days_7} · last 30 days {usage.window.days_30}
      </div>
    </div>
  );
}

export function KbDocumentPane({
  kb,
  doc,
  onHome,
  onOpen,
  onDeleted,
  onReplaceFile,
  detailsOpen,
  onDetailsOpenChange,
}: {
  kb: KnowledgeBase;
  doc: KbDocumentWithContent;
  onHome: () => void;
  onOpen: (documentId: string, heading?: string) => void;
  onDeleted: () => void;
  onReplaceFile: (file: File) => void;
  detailsOpen: boolean;
  onDetailsOpenChange: (open: boolean) => void;
}) {
  const invalidate = useInvalidateKb();
  const [params] = useSearchParams();
  const editorMode = params.get("editorMode");
  const openComments = useKbComments(doc.kb_id, { document_id: doc.id }).data?.counts.open ?? 0;
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Beside the document only on wide screens; narrower ones open details over it.
  const wide = useBreakpoint("lg");
  // Who linked here before a rename: links by the old title or path stop resolving after it.
  const [renamedFrom, setRenamedFrom] = useState<RenameBase | null>(null);
  const beforeEdit = useRef<RenameBase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const replaceInput = useRef<HTMLInputElement>(null);
  // Revision of the content the editor last loaded or saved. A save returns its revision before
  // the refetch lands, and a refetch with someone else's edit must not hide that conflict.
  const revision = useRef(doc.revision);

  // The server resolves [[links]]; only resolved targets render as links.
  const resolved = new Map(
    doc.links
      .filter((l) => l.document_id)
      .map((l) => [wikiLinkKey(l.target), l.document_id as string]),
  );
  const wikiLinks = {
    slugs: [...resolved.keys()],
    select: (key: string) => {
      const target = resolved.get(key);
      if (target) onOpen(target);
    },
  };

  async function act(action: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await action();
      await invalidate();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    await act(async () =>
      saveFile(
        await api.kb.original(doc.id),
        doc.original_name ?? doc.path.split("/").pop() ?? "document",
      ),
    );
  }
  function downloadMarkdown() {
    const name = (doc.path.split("/").pop() ?? "document").replace(/\.(md|markdown)$/i, "");
    saveFile(new Blob([doc.content], { type: "text/markdown;charset=utf-8" }), `${name}.md`);
  }

  const upload = doc.origin === "upload";
  // Uploads and non-Markdown folder copies keep the original file; Markdown copies are the text.
  const hasOriginal = upload || (doc.origin === "external" && !doc.editable);
  const brokenLinks =
    renamedFrom?.backlinks.filter(
      (b) => !doc.backlinks.some((now) => now.document_id === b.document_id),
    ) ?? [];
  const menuItem = (
    testId: string,
    icon: ReactNode,
    text: string,
    onClick: () => void,
    danger = false,
  ) => (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      disabled={busy}
      className={cn(
        "flex min-h-9 w-full items-center gap-2 rounded px-2 text-left text-sm outline-none hover:bg-surface-highest focus-visible:bg-surface-highest disabled:opacity-50",
        danger && "text-error",
      )}
      onClick={() => {
        setMenuOpen(false);
        onClick();
      }}
    >
      {icon}
      {text}
    </button>
  );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      <article
        data-testid="kb-document"
        className="min-w-0 lg:min-h-0 lg:flex-1 lg:overflow-y-auto"
      >
        <div className="w-full min-w-0 px-4 pb-16 pt-4 sm:px-8 sm:pt-6">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <nav
              aria-label="Breadcrumb"
              className="flex min-w-0 flex-1 basis-48 items-center gap-1 text-sm text-outline"
            >
              <button
                type="button"
                data-testid="kb-breadcrumb-kb"
                className="min-w-0 max-w-[60%] truncate hover:text-on-surface hover:underline"
                onClick={onHome}
              >
                {kb.name}
              </button>
              <ChevronRight size={14} className="shrink-0" aria-hidden />
              <span
                className="min-w-0 truncate font-mono text-xs"
                data-testid="kb-document-path"
                title={doc.path}
              >
                {doc.path}
              </span>
            </nav>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                size="sm"
                variant={detailsOpen ? "secondary" : "ghost"}
                aria-pressed={detailsOpen}
                data-testid="kb-details-toggle"
                onClick={() => onDetailsOpenChange(!detailsOpen)}
              >
                <PanelRight size={14} />
                Details
                {openComments > 0 && (
                  <span
                    data-testid="kb-details-open-comments"
                    title={`${openComments} open ${openComments === 1 ? "comment" : "comments"}`}
                    className="inline-flex items-center gap-1 text-xs tabular-nums text-outline"
                  >
                    <StateDot tone="warning" />
                    {openComments}
                  </span>
                )}
              </Button>
              <Popover.Root open={menuOpen} onOpenChange={setMenuOpen}>
                <Popover.Trigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Document actions"
                    aria-haspopup="menu"
                    data-testid="kb-doc-menu"
                  >
                    <MoreHorizontal size={16} />
                  </Button>
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Content
                    align="end"
                    sideOffset={4}
                    collisionPadding={8}
                    role="menu"
                    aria-label="Document actions"
                    className="z-50 w-52 rounded-md border border-outline-variant bg-surface-high p-1 shadow-lg"
                    onOpenAutoFocus={(event) => {
                      event.preventDefault();
                      (event.currentTarget as HTMLElement)
                        .querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')
                        ?.focus();
                    }}
                    onKeyDown={moveMenuFocus}
                  >
                    {menuItem("kb-doc-properties", <Pencil size={14} />, "Title and labels", () => {
                      beforeEdit.current = { title: doc.title, backlinks: doc.backlinks };
                      setEditing(true);
                    })}
                    {!hasOriginal &&
                      menuItem(
                        "kb-doc-download-markdown",
                        <FileDown size={14} />,
                        "Download Markdown",
                        downloadMarkdown,
                      )}
                    {hasOriginal &&
                      menuItem(
                        "kb-doc-download",
                        <Download size={14} />,
                        "Download original",
                        () => void download(),
                      )}
                    {upload &&
                      menuItem(
                        "kb-doc-reparse",
                        <RefreshCw size={14} />,
                        "Parse again",
                        () => void act(() => api.kb.reparse(doc.id)),
                      )}
                    {upload &&
                      menuItem("kb-doc-replace", <FileUp size={14} />, "Replace file", () =>
                        replaceInput.current?.click(),
                      )}
                    {doc.origin !== "external" &&
                      menuItem(
                        "kb-doc-delete",
                        <Trash2 size={14} />,
                        "Delete document",
                        () => setDeleting(true),
                        true,
                      )}
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
            </div>
          </div>
          <header className="mb-2 mt-4 space-y-2">
            <h1 data-testid="kb-document-title" className="break-words text-3xl font-medium">
              {doc.title}
            </h1>
            {doc.description && <p className="text-outline">{doc.description}</p>}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-outline">
              {doc.labels.length > 0 && (
                <span className="flex flex-wrap gap-1">
                  {doc.labels.map((l) => (
                    <Badge key={l} variant="secondary" data-testid="kb-document-label">
                      {l}
                    </Badge>
                  ))}
                </span>
              )}
              {doc.parse_state !== "ok" && (
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5",
                    doc.parse_state === "failed" && "text-error",
                  )}
                >
                  <StateDot
                    tone={
                      doc.parse_state === "failed"
                        ? "error"
                        : doc.parse_state === "partial"
                          ? "warning"
                          : "progress"
                    }
                  />
                  <span data-testid="kb-parse-state">{STATE_LABEL[doc.parse_state]}</span>
                </span>
              )}
              {doc.folder_sync && (
                <span
                  data-testid="kb-folder-sync"
                  title={
                    doc.folder_sync === "following"
                      ? "Copied from a synced folder; scans pick up changes to the file"
                      : "Edited in ORC; scans no longer change this copy"
                  }
                >
                  {doc.folder_sync === "following"
                    ? "Follows folder file"
                    : "Edited, no longer synced"}
                </span>
              )}
              {doc.stale && (
                <span className="text-warning" data-testid="kb-document-stale">
                  Stale: a source changed
                </span>
              )}
              <span>
                Updated {new Date(doc.updated_at).toLocaleDateString()} by {doc.updated_by}
              </span>
            </div>
          </header>
          {doc.warnings.length > 0 && (
            <ul data-testid="kb-document-warnings" className="mb-2 space-y-1 text-sm text-warning">
              {doc.warnings.map((w) => (
                <li key={w} className="flex gap-2">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  {w}
                </li>
              ))}
            </ul>
          )}
          {upload && (
            <p className="mb-2 text-sm text-outline">
              Text parsed from {doc.original_name ?? "the upload"} ({formatBytes(doc.size_bytes)}
              {doc.parser ? `, ${doc.parser.id} ${doc.parser.version}` : ""}). Replace the file to
              change it.
            </p>
          )}
          {doc.folder_sync === "following" && (editorMode === "edit" || editorMode === "split") && (
            <p
              role="status"
              data-testid="kb-folder-sync-warning"
              className="mb-2 text-sm text-warning"
            >
              This copy follows a file in a synced folder. Saving here stops it following that file;
              later changes to the file will not reach it.
            </p>
          )}
          {error && (
            <p role="alert" data-testid="kb-document-error" className="mb-2 text-sm text-error">
              {error}
            </p>
          )}
          {renamedFrom && brokenLinks.length > 0 && (
            <div
              role="status"
              data-testid="kb-rename-broken-links"
              className="mb-2 flex flex-wrap items-center gap-x-2 text-sm text-warning"
            >
              <AlertTriangle size={14} className="shrink-0" aria-hidden />
              <span className="min-w-0 flex-1">
                {brokenLinks.length === 1 ? "1 document" : `${brokenLinks.length} documents`} linked
                to “{renamedFrom.title}” by its old title or path; those links now show as missing:{" "}
                {brokenLinks.map((b, i) => (
                  <span key={b.document_id}>
                    {i > 0 && ", "}
                    <button
                      type="button"
                      className="underline underline-offset-2 hover:text-on-surface"
                      onClick={() => onOpen(b.document_id)}
                    >
                      {b.title}
                    </button>
                  </span>
                ))}
              </span>
              <Button size="sm" variant="ghost" onClick={() => setRenamedFrom(null)}>
                Dismiss
              </Button>
            </div>
          )}
          <DocumentWorkspace
            key={kbWorkspaceId(doc.id)}
            documentId={kbWorkspaceId(doc.id)}
            path={doc.editable ? doc.path : `${doc.path}.md`}
            content={doc.content}
            wikiLinks={wikiLinks}
            testId="kb-document-content"
            layout="page"
            pageTitle={doc.title}
            hideFrontmatter
            onSave={
              doc.editable
                ? async (content, base) => {
                    try {
                      const saved = await api.kb.updateDocument(doc.id, {
                        expected_revision: base === doc.content ? doc.revision : revision.current,
                        content,
                      });
                      revision.current = saved.revision;
                      return content;
                    } finally {
                      // On a conflict this loads the other writer's version for Discard.
                      await invalidate();
                    }
                  }
                : undefined
            }
          />
        </div>
      </article>
      {detailsOpen && wide && <DocumentDetails doc={doc} onOpen={onOpen} />}
      {!wide && (
        <Sheet open={detailsOpen} onOpenChange={onDetailsOpenChange}>
          <SheetContent className="w-[360px]" aria-describedby={undefined}>
            <SheetHeader className="py-3">
              <SheetTitle>Details</SheetTitle>
            </SheetHeader>
            <SheetBody className="p-0 sm:p-0">
              <DocumentDetails
                doc={doc}
                onOpen={(id, heading) => {
                  onDetailsOpenChange(false);
                  onOpen(id, heading);
                }}
              />
            </SheetBody>
          </SheetContent>
        </Sheet>
      )}
      <input
        ref={replaceInput}
        type="file"
        hidden
        data-testid="kb-doc-replace-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onReplaceFile(file);
          e.target.value = "";
        }}
      />
      {editing && (
        <DocumentPropertiesDialog
          doc={doc}
          linkedFrom={doc.backlinks.length}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            // The dialog refetches before this runs; compare with the document as it was opened.
            setRenamedFrom(beforeEdit.current);
          }}
        />
      )}
      <ConfirmDialog
        open={deleting}
        title="Delete document"
        description={`Delete "${doc.title}" and its revision history${upload ? " and uploaded file" : ""}?`}
        isPending={busy}
        onCancel={() => setDeleting(false)}
        onConfirm={async () => {
          setDeleting(false);
          if (await act(() => api.kb.removeDocument(doc.id))) onDeleted();
        }}
      />
    </div>
  );
}

function DetailsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h2 className="text-sm font-medium text-outline">{title}</h2>
      {children}
    </section>
  );
}

/** Navigation and conversation around the document; bookkeeping stays folded away. */
function DocumentDetails({
  doc,
  onOpen,
}: {
  doc: KbDocumentWithContent;
  onOpen: (documentId: string, heading?: string) => void;
}) {
  const usage = useKbDocumentUsage(doc.id);
  const revisions = useKbRevisions(doc.id);
  const linkClass = "block min-h-8 w-full break-words text-left text-primary hover:underline";
  return (
    <aside
      data-testid="kb-document-details"
      aria-label="Document details"
      className="w-full shrink-0 space-y-6 p-4 text-sm lg:min-h-0 lg:w-80 lg:overflow-y-auto lg:border-l lg:border-outline-variant"
    >
      {doc.outline.length > 0 && (
        <DetailsSection title="On this page">
          <nav aria-label="Outline" className="space-y-0.5">
            {doc.outline.map((h) => (
              <button
                type="button"
                key={`${h.block}-${h.text}`}
                className="block min-h-7 w-full truncate text-left text-outline hover:text-on-surface"
                style={{ paddingLeft: `${(h.level - 1) * 0.75}rem` }}
                onClick={() => onOpen(doc.id, h.text)}
              >
                {h.text}
              </button>
            ))}
          </nav>
        </DetailsSection>
      )}
      {doc.links.length > 0 && (
        <DetailsSection title={`Links to (${doc.links.length})`}>
          {doc.links.map((l) =>
            l.document_id ? (
              <button
                type="button"
                key={l.target}
                data-testid="kb-outgoing-link"
                className={linkClass}
                onClick={() => onOpen(l.document_id as string)}
              >
                {l.title ?? l.target}
              </button>
            ) : (
              <p key={l.target} className="py-1 text-outline" data-testid="kb-unresolved-link">
                {l.target} <span className="text-xs">(no such document)</span>
              </p>
            ),
          )}
        </DetailsSection>
      )}
      {doc.backlinks.length > 0 && (
        <DetailsSection title={`Linked from (${doc.backlinks.length})`}>
          {doc.backlinks.map((b) => (
            <button
              type="button"
              key={b.document_id}
              data-testid="kb-backlink"
              className={linkClass}
              onClick={() => onOpen(b.document_id)}
            >
              {b.title}
            </button>
          ))}
        </DetailsSection>
      )}
      <div className="border-y border-outline-variant">
        <KbComments kbId={doc.kb_id} documentId={doc.id} heading="h2" compact />
      </div>
      <details data-testid="kb-doc-history" className="group">
        <summary className="flex min-h-9 cursor-pointer list-none items-center gap-1.5 font-medium [&::-webkit-details-marker]:hidden">
          <ChevronRight
            size={14}
            aria-hidden
            className="text-outline transition-transform group-open:rotate-90"
          />
          Usage and history
        </summary>
        <div className="mt-3 space-y-5 pl-5">
          {usage.data ? (
            <UsageTable usage={usage.data} testId="kb-doc-usage" />
          ) : (
            <p className="text-outline">{usage.error ? "Usage unavailable" : "Loading…"}</p>
          )}
          <ol className="space-y-2" data-testid="kb-revisions">
            {revisions.data?.map((r) => (
              <li key={r.revision} data-testid="kb-revision">
                <div>
                  Revision {r.revision} · {r.actor}
                  <span className="text-outline"> via {r.source}</span>
                </div>
                <div className="text-xs text-outline">
                  {new Date(r.created_at).toLocaleString()}
                  {r.note ? ` · ${r.note}` : ""}
                </div>
              </li>
            ))}
          </ol>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs text-outline">
            <dt>Search</dt>
            <dd data-testid="kb-index-state">{STATE_LABEL[doc.index_state] ?? doc.index_state}</dd>
            <dt>Origin</dt>
            <dd>{doc.origin}</dd>
            <dt>Type</dt>
            <dd>{doc.media_type}</dd>
            <dt>Size</dt>
            <dd>{formatBytes(doc.size_bytes)}</dd>
            <dt>Updated</dt>
            <dd>
              {new Date(doc.updated_at).toLocaleString()} by {doc.updated_by}
            </dd>
            <dt>ID</dt>
            <dd className="break-all font-mono">{doc.id}</dd>
          </dl>
        </div>
      </details>
    </aside>
  );
}
