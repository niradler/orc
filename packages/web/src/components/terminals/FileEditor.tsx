import { useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import { CodeEditor } from "@/components/CodeEditor";

type Draft = { original: string; content: string };
const drafts = new Map<string, Draft>();
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (event) => {
    if (drafts.size === 0) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

export function FileEditor({
  terminalId,
  path,
  content,
  readOnly,
  onDirty,
}: {
  terminalId: string;
  path: string;
  content: string;
  readOnly: boolean;
  onDirty: (dirty: boolean) => void;
}): ReactElement {
  const draftKey = `${terminalId}:${path}`;
  const initial = useRef(drafts.get(draftKey) ?? { original: content, content });
  const original = useRef(initial.current.original);
  const document = useRef(initial.current.content);
  const [dirty, setDirty] = useState(initial.current.content !== initial.current.original);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState(initial.current.content);
  const queryClient = useQueryClient();
  const saveAction = useRef<() => void>(() => {});
  const pending = useRef(false);
  const active = useRef(false);
  const dirtyCallback = useRef(onDirty);
  dirtyCallback.current = onDirty;

  async function save(): Promise<void> {
    if (pending.current || readOnly || document.current === original.current) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    const savedContent = document.current;
    try {
      await api.git.saveFile(terminalId, path, savedContent, original.current);
      original.current = savedContent;
      const changed = document.current !== savedContent;
      setDirty(changed);
      if (active.current) dirtyCallback.current(changed);
      if (changed) drafts.set(draftKey, { original: savedContent, content: document.current });
      else drafts.delete(draftKey);
      void queryClient.invalidateQueries({ queryKey: ["checkout-files", terminalId, path] });
      void queryClient.invalidateQueries({ queryKey: ["git", terminalId] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save file");
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }
  saveAction.current = () => void save();

  useEffect(() => {
    active.current = true;
    dirtyCallback.current(initial.current.content !== initial.current.original);
    return () => {
      active.current = false;
    };
  }, []);

  function change(content: string): void {
    document.current = content;
    setText(content);
    const changed = content !== original.current;
    setDirty(changed);
    dirtyCallback.current(changed);
    if (changed) drafts.set(draftKey, { original: original.current, content });
    else drafts.delete(draftKey);
  }

  function reload(): void {
    if (!window.confirm("Discard your edits and reload the file from disk?")) return;
    void api.git
      .files(terminalId, path)
      .then((file) => {
        if (file.content === null || file.binary || file.truncated)
          throw new Error("File is no longer editable");
        original.current = file.content;
        document.current = file.content;
        drafts.delete(draftKey);
        setText(file.content);
        setDirty(false);
        dirtyCallback.current(false);
        setError(null);
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Could not reload file"),
      );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="file-editor">
      <div className="flex shrink-0 items-center gap-1 border-b border-surface-highest px-2 py-1">
        <button
          type="button"
          data-testid="file-save"
          disabled={!dirty || saving || readOnly}
          onClick={() => void save()}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-primary hover:bg-surface-highest disabled:opacity-40"
          title="Save (Ctrl/Cmd+S)"
        >
          <Save size={14} />
          {saving ? "Saving…" : "Save"}
        </button>
        <span
          data-testid="file-save-status"
          className="min-w-0 flex-1 truncate text-[10px] text-outline"
        >
          {readOnly ? "Read-only preview" : dirty ? "Unsaved changes" : "Saved"}
        </span>
      </div>
      {error && (
        <div role="alert" className="shrink-0 border-b border-error/30 p-2 text-xs text-error">
          {error}
          <button
            type="button"
            data-testid="file-reload"
            onClick={reload}
            className="ml-2 underline"
          >
            Reload from disk
          </button>
        </div>
      )}
      <div data-testid="file-preview" className="min-h-0 flex-1 overflow-hidden">
        <CodeEditor
          path={path}
          value={text}
          onChange={change}
          onSave={() => saveAction.current()}
          readOnly={readOnly}
          height="100%"
          testId="file-editor-input"
        />
      </div>
    </div>
  );
}
