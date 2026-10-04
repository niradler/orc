import { indentWithTab } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { openSearchPanel } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap } from "@codemirror/view";
import { useQueryClient } from "@tanstack/react-query";
import { basicSetup } from "codemirror";
import { Save, Search, WrapText } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";

type Draft = { original: string; content: string };
const drafts = new Map<string, Draft>();
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (event) => {
    if (drafts.size === 0) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

function language(path: string): Extension {
  const extension = path.split(".").pop()?.toLowerCase();
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(extension ?? ""))
    return javascript({
      typescript: extension === "ts" || extension === "tsx",
      jsx: extension === "jsx" || extension === "tsx",
    });
  if (extension === "json") return json();
  if (extension === "css") return css();
  if (extension === "html") return html();
  if (extension === "md") return markdown();
  if (extension === "py") return python();
  return [];
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
  const lineBreak = useRef(initial.current.original.includes("\r\n") ? "\r\n" : "\n");
  const document = useRef(initial.current.content);
  const [dirty, setDirty] = useState(initial.current.content !== initial.current.original);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wrap, setWrap] = useState(false);
  const [lines, setLines] = useState(initial.current.content.split("\n").length);
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const wrapExtension = useRef(new Compartment());
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
    if (!parent.current) return;
    active.current = true;
    dirtyCallback.current(initial.current.content !== initial.current.original);
    const editor = new EditorView({
      parent: parent.current,
      state: EditorState.create({
        doc: initial.current.content,
        extensions: [
          basicSetup,
          oneDark,
          language(path),
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          EditorView.contentAttributes.of({
            "aria-label": `Edit ${path}`,
            "data-testid": "file-editor-input",
          }),
          keymap.of([
            {
              key: "Mod-s",
              run: () => {
                saveAction.current();
                return true;
              },
            },
            indentWithTab,
          ]),
          wrapExtension.current.of([]),
          EditorView.theme({
            "&": { height: "100%", backgroundColor: "#090e1a", fontSize: "12px" },
            ".cm-scroller": { overflow: "auto", fontFamily: "monospace" },
            ".cm-gutters": { backgroundColor: "#111827", borderRight: "1px solid #1e2537" },
            ".cm-activeLine": { backgroundColor: "#1e253744" },
            ".cm-content": { padding: "12px 0" },
            ".cm-line": { padding: "0 12px" },
          }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            document.current = update.state.doc.toString().replace(/\n/g, lineBreak.current);
            const changed = document.current !== original.current;
            setDirty(changed);
            dirtyCallback.current(changed);
            setLines(update.state.doc.lines);
            if (changed)
              drafts.set(draftKey, { original: original.current, content: document.current });
            else drafts.delete(draftKey);
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      active.current = false;
      view.current = null;
      editor.destroy();
    };
  }, [path, readOnly, draftKey]);

  function reload(): void {
    if (!window.confirm("Discard your edits and reload the file from disk?")) return;
    void api.git
      .files(terminalId, path)
      .then((file) => {
        if (file.content === null || file.binary || file.truncated)
          throw new Error("File is no longer editable");
        original.current = file.content;
        document.current = file.content;
        lineBreak.current = file.content.includes("\r\n") ? "\r\n" : "\n";
        drafts.delete(draftKey);
        view.current?.dispatch({
          changes: { from: 0, to: view.current.state.doc.length, insert: file.content },
        });
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
        <button
          type="button"
          aria-label="Find in file"
          title="Find (Ctrl/Cmd+F)"
          onClick={() => {
            if (view.current) {
              openSearchPanel(view.current);
            }
          }}
          className="rounded p-1 text-outline hover:bg-surface-highest"
        >
          <Search size={14} />
        </button>
        <button
          type="button"
          aria-label="Word wrap"
          title="Word wrap"
          aria-pressed={wrap}
          onClick={() => {
            const next = !wrap;
            setWrap(next);
            view.current?.dispatch({
              effects: wrapExtension.current.reconfigure(next ? EditorView.lineWrapping : []),
            });
          }}
          className={`rounded p-1 hover:bg-surface-highest ${wrap ? "text-primary" : "text-outline"}`}
        >
          <WrapText size={14} />
        </button>
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
      <div ref={parent} data-testid="file-preview" className="min-h-0 flex-1 overflow-hidden" />
      <footer className="shrink-0 border-t border-surface-highest px-3 py-1 text-[10px] text-outline">
        {lines} {lines === 1 ? "line" : "lines"} · UTF-8
      </footer>
    </div>
  );
}
