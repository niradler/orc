import { indentWithTab } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import { Annotation, Compartment, EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, placeholder as editorPlaceholder, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { Search, WrapText } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CodeEditorProps } from "@/components/CodeEditor";
import { Markdown } from "@/components/Markdown";
import { editorLanguage, isMarkdownFile } from "@/lib/editor-language";
import { useTheme } from "@/lib/theme";

const externalChange = Annotation.define<boolean>();

export function SourceEditor({
  path,
  value,
  onChange,
  onSave,
  readOnly = false,
  height = 320,
  testId = "code-editor-input",
  id,
  label,
  placeholder,
  hidePreview = false,
  defaultWrap = false,
}: CodeEditorProps) {
  const { theme } = useTheme();
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const initial = useRef({
    path,
    value,
    readOnly,
    testId,
    id,
    label,
    placeholder,
    defaultWrap,
    theme,
  });
  const changeAction = useRef(onChange);
  changeAction.current = onChange;
  const saveAction = useRef(onSave);
  saveAction.current = onSave;
  const lineBreak = useRef(value.includes("\r\n") ? "\r\n" : "\n");
  const language = useRef(new Compartment());
  const colorTheme = useRef(new Compartment());
  const editable = useRef(new Compartment());
  const attributes = useRef(new Compartment());
  const wrapping = useRef(new Compartment());
  const [wrap, setWrap] = useState(defaultWrap || isMarkdownFile(path));
  const [preview, setPreview] = useState(false);
  const [lines, setLines] = useState(value.split(/\r?\n/).length);

  useEffect(() => {
    if (!parent.current) return;
    const original = initial.current;
    const editor = new EditorView({
      parent: parent.current,
      state: EditorState.create({
        doc: original.value,
        extensions: [
          basicSetup,
          colorTheme.current.of(original.theme === "dark" ? oneDark : []),
          language.current.of(editorLanguage(original.path)),
          editable.current.of([
            EditorState.readOnly.of(original.readOnly),
            EditorView.editable.of(!original.readOnly),
          ]),
          attributes.current.of(
            EditorView.contentAttributes.of({
              "aria-label": original.label ?? `Edit ${original.path}`,
              "data-testid": original.testId,
              ...(original.id ? { id: original.id } : {}),
            }),
          ),
          original.placeholder ? editorPlaceholder(original.placeholder) : [],
          keymap.of([
            {
              key: "Mod-s",
              run: () => {
                saveAction.current?.();
                return true;
              },
            },
            indentWithTab,
          ]),
          wrapping.current.of(
            original.defaultWrap || isMarkdownFile(original.path) ? EditorView.lineWrapping : [],
          ),
          EditorView.theme({
            "&": {
              height: "100%",
              backgroundColor: "rgb(var(--background))",
              color: "rgb(var(--foreground))",
              fontSize: "14px",
            },
            "@media (max-width: 640px)": { "&": { fontSize: "16px" } },
            ".cm-scroller": {
              overflow: "auto",
              fontFamily: '"IBM Plex Mono", Consolas, monospace',
            },
            ".cm-gutters": {
              backgroundColor: "rgb(var(--surface-low))",
              color: "rgb(var(--muted-foreground))",
              borderRight: "1px solid rgb(var(--border))",
            },
            ".cm-activeLine, .cm-activeLineGutter": {
              backgroundColor: "rgb(var(--surface-highest) / 0.4)",
            },
            ".cm-cursor": { borderLeftColor: "rgb(var(--foreground))" },
            ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
              backgroundColor: "rgb(var(--primary) / 0.25)",
            },
            ".cm-panels, .cm-tooltip": {
              backgroundColor: "rgb(var(--surface-high))",
              color: "rgb(var(--foreground))",
            },
            ".cm-textfield, .cm-button": {
              background: "rgb(var(--background))",
              color: "rgb(var(--foreground))",
              border: "1px solid rgb(var(--control-border))",
            },
            ".cm-textfield:focus-visible, .cm-button:focus-visible": {
              outline: "2px solid rgb(var(--focus))",
              outlineOffset: "3px",
            },
            ".cm-placeholder": { color: "rgb(var(--muted-foreground))" },
            ".cm-content": { padding: "12px 0" },
            ".cm-line": { padding: "0 12px" },
          }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            setLines(update.state.doc.lines);
            if (update.transactions.some((transaction) => transaction.annotation(externalChange)))
              return;
            changeAction.current?.(update.state.doc.toString().replace(/\n/g, lineBreak.current));
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      view.current = null;
      editor.destroy();
    };
  }, []);

  useEffect(() => {
    view.current?.dispatch({
      effects: colorTheme.current.reconfigure(theme === "dark" ? oneDark : []),
    });
  }, [theme]);

  useEffect(() => {
    view.current?.dispatch({
      effects: language.current.reconfigure(editorLanguage(path)),
    });
    setPreview(false);
  }, [path]);
  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);
  useEffect(() => {
    view.current?.dispatch({
      effects: attributes.current.reconfigure(
        EditorView.contentAttributes.of({
          "aria-label": label ?? `Edit ${path}`,
          "data-testid": testId,
          ...(id ? { id } : {}),
        }),
      ),
    });
  }, [id, label, path, testId]);
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    lineBreak.current = value.includes("\r\n") ? "\r\n" : "\n";
    if (editor.state.doc.toString() === value.replace(/\r\n/g, "\n")) return;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: value },
      annotations: externalChange.of(true),
    });
  }, [value]);

  return (
    <div
      data-testid="code-editor"
      data-file-path={path}
      data-read-only={readOnly}
      className="flex min-h-0 flex-col overflow-hidden rounded-sm border border-control-border"
      style={{ height }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-surface-highest px-2 py-1 text-xs">
        <span className="min-w-0 flex-1 truncate text-outline" title={path}>
          {path}
          {readOnly ? " · Read-only" : ""}
        </span>
        {!hidePreview && isMarkdownFile(path) && (
          <button
            type="button"
            data-testid="code-editor-preview-toggle"
            aria-pressed={preview}
            onClick={() => setPreview(!preview)}
            className="rounded px-2 py-1 hover:bg-surface-highest"
          >
            {preview ? "Show source" : "Preview Markdown"}
          </button>
        )}
        <button
          type="button"
          aria-label="Find in file"
          title="Find (Ctrl/Cmd+F)"
          onClick={() => {
            setPreview(false);
            if (view.current) openSearchPanel(view.current);
          }}
          className="inline-flex min-h-11 min-w-11 sm:min-h-8 sm:min-w-8 items-center justify-center rounded p-1 text-outline hover:bg-surface-highest"
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
              effects: wrapping.current.reconfigure(next ? EditorView.lineWrapping : []),
            });
          }}
          className={`inline-flex min-h-11 min-w-11 sm:min-h-8 sm:min-w-8 items-center justify-center rounded p-1 hover:bg-surface-highest ${wrap ? "text-primary" : "text-outline"}`}
        >
          <WrapText size={14} />
        </button>
      </div>
      <div ref={parent} className={`min-h-0 flex-1 overflow-hidden ${preview ? "hidden" : ""}`} />
      {preview && (
        <div
          data-testid="code-editor-markdown-preview"
          className="min-h-0 flex-1 overflow-auto p-3"
        >
          <Markdown>{value}</Markdown>
        </div>
      )}
      <footer className="shrink-0 border-t border-surface-highest px-3 py-1 text-[10px] text-outline">
        {lines} {lines === 1 ? "line" : "lines"} · UTF-8
      </footer>
    </div>
  );
}
