import { type ReactNode, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { MarkdownEditor, type MarkdownEditorProps } from "@/components/MarkdownEditor";
import { Button } from "@/components/ui/button";

type Draft = { original: string; content: string };
const drafts = new Map<string, Draft>();
const savingDocuments = new Set<string>();
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (event) => {
    if (!drafts.size) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

export function confirmDocumentClose(documentId: string): boolean {
  if (savingDocuments.has(documentId)) return false;
  if (!drafts.has(documentId)) return true;
  if (!window.confirm("Discard unsaved changes to this document?")) return false;
  drafts.delete(documentId);
  return true;
}

export function DocumentWorkspace({
  documentId,
  content,
  path,
  onSave,
  testId,
  wikiLinks,
  navigation,
  expanded,
  onExpandedChange,
  layout,
  pageTitle,
  hideFrontmatter,
}: {
  documentId: string;
  content: string;
  path: string;
  onSave?: (content: string, expectedContent: string) => Promise<string | undefined>;
  testId?: string;
  wikiLinks?: MarkdownEditorProps["wikiLinks"];
  navigation?: ReactNode;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  layout?: MarkdownEditorProps["layout"];
  pageTitle?: string;
  hideFrontmatter?: boolean;
}) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const requestedMode = params.get("editorMode");
  const mode = requestedMode === "edit" || requestedMode === "split" ? requestedMode : "read";
  const initial = useRef(drafts.get(documentId) ?? { original: content, content });
  const [draft, setDraft] = useState(initial.current.content);
  const [original, setOriginal] = useState(initial.current.original);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const currentDraft = useRef(initial.current.content);
  const dirty = draft !== original;
  useEffect(() => {
    if (drafts.has(documentId)) return;
    setDraft(content);
    currentDraft.current = content;
    setOriginal(content);
  }, [content, documentId]);

  function change(next: string): void {
    currentDraft.current = next;
    setDraft(next);
    if (next === original) drafts.delete(documentId);
    else drafts.set(documentId, { original, content: next });
  }
  async function save(): Promise<void> {
    if (!onSave || !dirty || pending.current) return;
    pending.current = true;
    savingDocuments.add(documentId);
    setSaving(true);
    setError(null);
    const submitted = currentDraft.current;
    try {
      const result = await onSave(submitted, original);
      const saved = typeof result === "string" ? result : submitted;
      setOriginal(saved);
      if (currentDraft.current === submitted) {
        drafts.delete(documentId);
        currentDraft.current = saved;
        setDraft(saved);
      } else drafts.set(documentId, { original: saved, content: currentDraft.current });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save document");
    } finally {
      pending.current = false;
      savingDocuments.delete(documentId);
      setSaving(false);
    }
  }
  function changeMode(nextMode: string): void {
    const next = new URLSearchParams(window.location.search);
    next.set("editorMode", nextMode);
    if (next.toString() === new URLSearchParams(window.location.search).toString()) return;
    navigate({ search: next.toString(), hash: window.location.hash });
  }
  function discard(): void {
    if (!confirmDocumentClose(documentId)) return;
    setDraft(content);
    setOriginal(content);
    currentDraft.current = content;
    setError(null);
  }
  const status = !onSave ? "Read-only" : saving ? "Saving…" : dirty ? "Unsaved changes" : "Saved";
  const notices = (
    <>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error} Your draft has been kept.
        </p>
      )}
      {dirty && content !== original && (
        <p role="status" className="text-sm text-outline">
          The document changed elsewhere. Your draft is preserved; saving will check for conflicts.
        </p>
      )}
    </>
  );
  if (layout === "page")
    // A page keeps one toolbar in every mode: saving appears there only when there is a change,
    // and save errors or conflicts show directly under it rather than as a bar above the modes.
    return (
      <div className="min-w-0" data-testid="document-workspace">
        <MarkdownEditor
          path={path}
          value={draft}
          onChange={change}
          onSave={() => void save()}
          readOnly={!onSave || saving}
          testId={testId}
          wikiLinks={wikiLinks}
          initialMode="read"
          mode={mode}
          onModeChange={changeMode}
          expanded={expanded}
          onExpandedChange={onExpandedChange}
          layout="page"
          pageTitle={pageTitle}
          hideFrontmatter={hideFrontmatter}
          notice={error || (dirty && content !== original) ? notices : undefined}
          actions={
            (mode !== "read" || dirty || saving) && (
              <>
                <span
                  data-testid="document-save-status"
                  role="status"
                  className="text-xs text-outline"
                >
                  {status}
                </span>
                {onSave && (dirty || saving) && (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      data-testid="document-discard"
                      disabled={saving}
                      onClick={discard}
                    >
                      Discard
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      data-testid="document-save"
                      disabled={saving}
                      onClick={() => void save()}
                    >
                      Save
                    </Button>
                  </>
                )}
              </>
            )
          }
        />
      </div>
    );
  return (
    <div className="min-w-0 space-y-3" data-testid="document-workspace">
      <MarkdownEditor
        path={path}
        value={draft}
        onChange={change}
        onSave={() => void save()}
        readOnly={!onSave || saving}
        testId={testId}
        wikiLinks={wikiLinks}
        initialMode="read"
        mode={mode}
        onModeChange={changeMode}
        expanded={expanded}
        onExpandedChange={onExpandedChange}
        layout={layout}
        header={
          <div className="space-y-2">
            {navigation && <div className="mb-3 min-w-0">{navigation}</div>}
            <div className="flex flex-wrap items-center gap-2">
              <span
                data-testid="document-save-status"
                role="status"
                className="min-w-0 flex-1 text-sm text-outline"
              >
                {status}
              </span>
              {onSave && (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    data-testid="document-discard"
                    disabled={!dirty || saving}
                    onClick={discard}
                  >
                    Discard changes
                  </Button>
                  <Button
                    type="button"
                    data-testid="document-save"
                    disabled={!dirty || saving}
                    onClick={() => void save()}
                  >
                    Save changes
                  </Button>
                </>
              )}
            </div>
            {notices}
          </div>
        }
      />
    </div>
  );
}
