import {
  KB_CALL_SOURCES,
  KB_READ_KINDS,
  type KbDocumentWithContent,
  type KbUsageStats,
} from "@orc/core/kb";
import { AlertTriangle, Download, FileUp, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { api } from "@/api/client";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DocumentWorkspace } from "@/components/DocumentWorkspace";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useInvalidateKb, useKbDocumentUsage, useKbRevisions } from "@/hooks/useKnowledge";
import { wikiLinkKey } from "@/lib/wiki-links";
import { KbComments } from "./KbComments";
import { DocumentPropertiesDialog } from "./KbDialogs";

export const kbWorkspaceId = (documentId: string) => `kb:${documentId}`;

const STATE_LABEL: Record<string, string> = {
  pending: "Processing",
  partial: "Partially parsed",
  failed: "Failed",
  lexical_ready: "Keyword search ready",
  semantic_pending: "Embedding",
  semantic_ready: "Semantic search ready",
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
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
  doc,
  onOpen,
  onDeleted,
  onReplaceFile,
  linksOpen,
}: {
  doc: KbDocumentWithContent;
  onOpen: (documentId: string, heading?: string) => void;
  onDeleted: () => void;
  onReplaceFile: (file: File) => void;
  linksOpen: boolean;
}) {
  const invalidate = useInvalidateKb();
  const usage = useKbDocumentUsage(doc.id);
  const revisions = useKbRevisions(doc.id);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
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
    await act(async () => {
      const blob = await api.kb.original(doc.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = doc.original_name ?? doc.path.split("/").pop() ?? "document";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }

  const upload = doc.origin === "upload";
  // Uploads and non-Markdown folder copies keep the original file; Markdown copies are the text.
  const hasOriginal = upload || (doc.origin === "external" && !doc.editable);
  const outgoing = doc.links;
  return (
    <div className="flex min-w-0 flex-1 flex-col lg:flex-row">
      <article data-testid="kb-document" className="min-w-0 flex-1 p-4 sm:p-6">
        <div className="mb-4 space-y-2">
          <p className="break-all font-mono text-xs text-outline" data-testid="kb-document-path">
            {doc.path}
          </p>
          <h1 data-testid="kb-document-title" className="break-words text-2xl font-medium">
            {doc.title}
          </h1>
          {doc.description && <p className="text-sm text-outline">{doc.description}</p>}
          <div className="flex flex-wrap items-center gap-2">
            {doc.labels.map((l) => (
              <Badge key={l} variant="secondary" data-testid="kb-document-label">
                {l}
              </Badge>
            ))}
            {doc.parse_state !== "ok" && (
              <Badge
                variant={doc.parse_state === "failed" ? "destructive" : "outline"}
                data-testid="kb-parse-state"
              >
                {STATE_LABEL[doc.parse_state]}
              </Badge>
            )}
            <Badge variant="outline" data-testid="kb-index-state">
              {STATE_LABEL[doc.index_state] ?? doc.index_state}
            </Badge>
            {doc.folder_sync && (
              <Badge
                variant="outline"
                data-testid="kb-folder-sync"
                title={
                  doc.folder_sync === "following"
                    ? "Copied from a registered folder; rescans pick up changes to the file"
                    : "Edited in ORC; rescans no longer change this copy"
                }
              >
                {doc.folder_sync === "following"
                  ? "Follows folder file"
                  : "Edited, no longer synced"}
              </Badge>
            )}
            {doc.stale && (
              <Badge variant="outline" className="text-warning" data-testid="kb-document-stale">
                Stale: a source changed
              </Badge>
            )}
          </div>
          {doc.warnings.length > 0 && (
            <ul data-testid="kb-document-warnings" className="space-y-1 text-sm text-warning">
              {doc.warnings.map((w) => (
                <li key={w} className="flex gap-2">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  {w}
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="ghost"
              data-testid="kb-doc-properties"
              onClick={() => setEditing(true)}
            >
              <Pencil size={14} />
              Properties
            </Button>
            {hasOriginal && (
              <Button
                size="sm"
                variant="ghost"
                data-testid="kb-doc-download"
                disabled={busy}
                onClick={download}
              >
                <Download size={14} />
                Original
              </Button>
            )}
            {upload && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="kb-doc-reparse"
                  disabled={busy}
                  onClick={() => act(() => api.kb.reparse(doc.id))}
                >
                  <RefreshCw size={14} />
                  Reparse
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="kb-doc-replace"
                  onClick={() => replaceInput.current?.click()}
                >
                  <FileUp size={14} />
                  Replace file
                </Button>
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
              </>
            )}
            {doc.origin !== "external" && (
              <Button
                size="sm"
                variant="ghost"
                className="text-error"
                data-testid="kb-doc-delete"
                onClick={() => setDeleting(true)}
              >
                <Trash2 size={14} />
                Delete
              </Button>
            )}
          </div>
          {error && (
            <p role="alert" data-testid="kb-document-error" className="text-sm text-error">
              {error}
            </p>
          )}
        </div>
        {upload && (
          <p className="mb-3 text-sm text-outline">
            Showing the text parsed from {doc.original_name ?? "the upload"} (
            {formatBytes(doc.size_bytes)}
            {doc.parser ? `, ${doc.parser.id} ${doc.parser.version}` : ""}). Replace the file to
            change it.
          </p>
        )}
        <DocumentWorkspace
          key={kbWorkspaceId(doc.id)}
          documentId={kbWorkspaceId(doc.id)}
          path={doc.editable ? doc.path : `${doc.path}.md`}
          content={doc.content}
          wikiLinks={wikiLinks}
          testId="kb-document-content"
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
      </article>
      {linksOpen && (
        <aside
          data-testid="kb-document-details"
          aria-label="Document details"
          className="w-full shrink-0 space-y-6 border-t border-outline-variant p-4 text-sm lg:w-72 lg:border-l lg:border-t-0"
        >
          <section>
            <h2 className="mb-2 font-medium">Usage</h2>
            {usage.data ? (
              <UsageTable usage={usage.data} testId="kb-doc-usage" />
            ) : (
              <p className="text-outline">{usage.error ? "Usage unavailable" : "Loading…"}</p>
            )}
          </section>
          <KbComments kbId={doc.kb_id} documentId={doc.id} heading="h2" />
          {doc.outline.length > 0 && (
            <section>
              <h2 className="mb-2 font-medium">Outline</h2>
              <nav aria-label="Outline" className="space-y-1">
                {doc.outline.map((h) => (
                  <button
                    type="button"
                    key={`${h.block}-${h.text}`}
                    className="block w-full truncate text-left text-primary hover:underline"
                    style={{ paddingLeft: `${(h.level - 1) * 0.75}rem` }}
                    onClick={() => onOpen(doc.id, h.text)}
                  >
                    {h.text}
                  </button>
                ))}
              </nav>
            </section>
          )}
          <section>
            <h2 className="mb-2 font-medium">Links ({outgoing.length})</h2>
            {outgoing.map((l) =>
              l.document_id ? (
                <button
                  type="button"
                  key={l.target}
                  data-testid="kb-outgoing-link"
                  className="block min-h-9 w-full break-words text-left text-primary hover:underline"
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
            {!outgoing.length && <p className="text-outline">Link documents with [[Title]].</p>}
          </section>
          <section>
            <h2 className="mb-2 font-medium">Backlinks ({doc.backlinks.length})</h2>
            {doc.backlinks.map((b) => (
              <button
                type="button"
                key={b.document_id}
                data-testid="kb-backlink"
                className="block min-h-9 w-full break-words text-left text-primary hover:underline"
                onClick={() => onOpen(b.document_id)}
              >
                {b.title}
              </button>
            ))}
            {!doc.backlinks.length && <p className="text-outline">Nothing links here yet.</p>}
          </section>
          <section>
            <h2 className="mb-2 font-medium">History</h2>
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
          </section>
          <section className="space-y-1 text-xs text-outline">
            <div>Origin: {doc.origin}</div>
            <div>Type: {doc.media_type}</div>
            <div>Size: {formatBytes(doc.size_bytes)}</div>
            <div>
              Updated {new Date(doc.updated_at).toLocaleString()} by {doc.updated_by}
            </div>
            <div className="break-all font-mono">ID {doc.id}</div>
          </section>
        </aside>
      )}
      {editing && (
        <DocumentPropertiesDialog
          doc={doc}
          onClose={() => setEditing(false)}
          onSaved={() => setEditing(false)}
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
