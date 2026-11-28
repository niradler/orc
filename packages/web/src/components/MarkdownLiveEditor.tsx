import { indentWithTab, redo, undo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { Annotation, EditorState, Prec, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  placeholder as editorPlaceholder,
  keymap,
  WidgetType,
} from "@codemirror/view";
import { basicSetup } from "codemirror";
import {
  Bold,
  Code2,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  Redo2,
  Strikethrough,
  Table2,
  Undo2,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  calloutTemplate,
  htmlToMarkdown,
  parseTable,
  SLASH_COMMANDS,
  type SlashCommand,
  tableTemplate,
} from "@/lib/live-markdown";
import { imageRendering as rendering } from "@/lib/markdown-images";
import { cn } from "@/lib/utils";

type Slash = { from: number; to: number; query: string; top: number; left: number };

const externalChange = Annotation.define<boolean>();

export type MarkdownLiveEditorProps = {
  path: string;
  value: string;
  onChange?: (value: string) => void;
  onSave?: () => void;
  readOnly?: boolean;
  testId?: string;
  id?: string;
  label?: string;
  placeholder?: string;
  height?: number | string;
  className?: string;
  compact?: boolean;
  wikiLinks?: {
    slugs: string[];
    select: (key: string) => void;
  };
  /** Stores a pasted image and returns the URL to insert; without it images use data URLs. */
  onUploadImage?: (file: File) => Promise<string>;
};

const HIDE = Decoration.replace({});

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }
  eq(other: WidgetType) {
    return other instanceof ImageWidget && other.src === this.src && other.alt === this.alt;
  }
  toDOM() {
    const shown = rendering(this.src);
    if (shown.kind === "inline") {
      const img = document.createElement("img");
      img.src = shown.src;
      img.alt = this.alt;
      img.className = "cm-live-image";
      img.loading = "lazy";
      return img;
    }
    const link = document.createElement("a");
    link.href = shown.kind === "link" ? shown.href : this.src;
    link.textContent = this.alt || this.src;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.className = "cm-live-remote";
    return link;
  }
  ignoreEvent() {
    return true;
  }
}

class RuleWidget extends WidgetType {
  toDOM() {
    const hr = document.createElement("hr");
    hr.className = "cm-live-rule";
    return hr;
  }
  ignoreEvent() {
    return true;
  }
}

class TableWidget extends WidgetType {
  constructor(readonly raw: string) {
    super();
  }
  eq(other: WidgetType) {
    return other instanceof TableWidget && other.raw === this.raw;
  }
  toDOM() {
    const model = parseTable(this.raw.split("\n"));
    const wrap = document.createElement("div");
    wrap.className = "cm-live-table-wrap";
    if (!model) {
      wrap.textContent = this.raw;
      return wrap;
    }
    const table = document.createElement("table");
    table.className = "cm-live-table";
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    model.headers.forEach((cell, i) => {
      const th = document.createElement("th");
      th.textContent = cell;
      th.style.textAlign = model.aligns[i] ?? "left";
      headRow.append(th);
    });
    head.append(headRow);
    table.append(head);
    const body = document.createElement("tbody");
    for (const row of model.rows) {
      const tr = document.createElement("tr");
      model.headers.forEach((_, i) => {
        const td = document.createElement("td");
        td.textContent = row[i] ?? "";
        td.style.textAlign = model.aligns[i] ?? "left";
        tr.append(td);
      });
      body.append(tr);
    }
    table.append(body);
    wrap.append(table);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly from: number,
    readonly to: number,
  ) {
    super();
  }
  eq(other: WidgetType) {
    return (
      other instanceof CheckboxWidget &&
      other.checked === this.checked &&
      other.from === this.from &&
      other.to === this.to
    );
  }
  toDOM(view: EditorView) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = this.checked;
    input.className = "cm-live-task";
    input.setAttribute("aria-label", this.checked ? "Mark task incomplete" : "Mark task complete");
    input.addEventListener("change", () => {
      view.dispatch({
        changes: { from: this.from, to: this.to, insert: this.checked ? "[ ]" : "[x]" },
      });
      view.focus();
    });
    return input;
  }
  ignoreEvent() {
    return true;
  }
}

const H1 = Decoration.line({ class: "cm-live-h1" });
const H2 = Decoration.line({ class: "cm-live-h2" });
const H3 = Decoration.line({ class: "cm-live-h3" });
const H4 = Decoration.line({ class: "cm-live-h4" });
const QUOTE = Decoration.line({ class: "cm-live-quote" });
const CODE = Decoration.line({ class: "cm-live-code" });
const TABLE = Decoration.line({ class: "cm-live-table-line" });
const ACTIVE = Decoration.line({ class: "cm-live-active" });

const MARKS = {
  strong: Decoration.mark({ class: "cm-live-strong" }),
  em: Decoration.mark({ class: "cm-live-em" }),
  strike: Decoration.mark({ class: "cm-live-strike" }),
  code: Decoration.mark({ class: "cm-live-inline-code" }),
  link: Decoration.mark({ class: "cm-live-link" }),
  wiki: Decoration.mark({ class: "cm-live-wiki" }),
  checked: Decoration.mark({ class: "cm-live-checked" }),
};

type Range = { from: number; to: number; deco: Decoration };

function inlineRanges(line: string, offset: number, active: boolean): Range[] {
  if (active) return [];
  const out: Range[] = [];
  const push = (from: number, to: number, deco: Decoration) =>
    out.push({ from: offset + from, to: offset + to, deco });
  const image = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of line.matchAll(image)) {
    push(
      match.index ?? 0,
      (match.index ?? 0) + match[0].length,
      Decoration.replace({ widget: new ImageWidget(match[2] ?? "", match[1] ?? "") }),
    );
  }
  const patterns: [RegExp, "strong" | "em" | "strike" | "code" | "link" | "wiki"][] = [
    [/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, "wiki"],
    [/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, "link"],
    [/`([^`\n]+)`/g, "code"],
    [/\*\*([^*\n]+)\*\*/g, "strong"],
    [/__([^_\n]+)__/g, "strong"],
    [/~~([^~\n]+)~~/g, "strike"],
    [/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "em"],
  ];
  for (const [re, kind] of patterns) {
    for (const match of line.matchAll(re)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (out.some((r) => start < r.to && end > r.from)) continue;
      if (kind === "link") {
        const textStart = start + 1;
        const textEnd = textStart + (match[1]?.length ?? 0);
        push(textStart, textEnd, MARKS.link);
        push(start, textStart, HIDE);
        push(textEnd, end, HIDE);
      } else if (kind === "wiki") {
        const inner = match[0].slice(2, -2);
        const label = match[2] ?? match[1] ?? "";
        const labelStart = start + 2 + inner.indexOf(label);
        push(labelStart, labelStart + label.length, MARKS.wiki);
        push(start, labelStart, HIDE);
        push(labelStart + label.length, end, HIDE);
      } else {
        push(
          start,
          start +
            (match[0].startsWith("**") || match[0].startsWith("__") || match[0].startsWith("~~")
              ? 2
              : 1),
          HIDE,
        );
        push(
          start +
            (match[0].startsWith("**") || match[0].startsWith("__") || match[0].startsWith("~~")
              ? 2
              : 1),
          end -
            (match[0].startsWith("**") || match[0].startsWith("__") || match[0].startsWith("~~")
              ? 2
              : 1),
          MARKS[kind],
        );
        push(
          end -
            (match[0].startsWith("**") || match[0].startsWith("__") || match[0].startsWith("~~")
              ? 2
              : 1),
          end,
          HIDE,
        );
      }
    }
  }
  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}

function buildDecorations(state: EditorState): DecorationSet {
  const ranges: Range[] = [];
  const active = (from: number, to: number) =>
    state.selection.ranges.some((r) => r.from <= to && r.to >= from);
  const doc = state.doc;
  const first = 1;
  const last = doc.lines;
  // Block context is derived from the start so a visible range that begins inside a fence or
  // table still renders correctly.
  let fence: string | null = null;
  let frontmatterEnd = -1;
  if (doc.lines > 0 && doc.line(1).text.trim() === "---") {
    for (let n = 2; n <= Math.min(doc.lines, 400); n++) {
      if (doc.line(n).text.trim() === "---") {
        frontmatterEnd = n;
        break;
      }
    }
  }
  let tableStart = -1;
  let tableEnd = -1;
  for (let n = 1; n <= last; n++) {
    if (tableStart > 0 && n > tableEnd) {
      tableStart = -1;
      tableEnd = -1;
    }
    const line = doc.line(n);
    const text = line.text;
    const mark = text.match(/^(```|~~~)/)?.[1];
    if (n === 1 && text.trim() === "---" && frontmatterEnd > 0) {
      if (!active(line.from, doc.line(frontmatterEnd).to)) {
        ranges.push({
          from: line.from,
          to: doc.line(frontmatterEnd).to,
          deco: Decoration.replace({
            block: true,
            widget: new (class extends WidgetType {
              toDOM() {
                const span = document.createElement("span");
                span.className = "cm-live-properties";
                span.textContent = "Properties";
                return span;
              }
            })(),
          }),
        });
      } else ranges.push({ from: line.from, to: line.from, deco: ACTIVE });
      n = frontmatterEnd;
      continue;
    }
    if (n < first) {
      if (fence) {
        if (mark) fence = null;
      } else if (mark) fence = mark;
      continue;
    }
    if (fence) {
      if (mark) {
        ranges.push({ from: line.from, to: line.to, deco: HIDE });
        fence = null;
      } else {
        ranges.push({ from: line.from, to: line.from, deco: CODE });
        if (active(line.from, line.to))
          ranges.push({ from: line.from, to: line.from, deco: ACTIVE });
        else for (const r of inlineRanges(text, line.from, false)) ranges.push(r);
      }
      continue;
    }
    if (mark) {
      fence = mark;
      ranges.push({ from: line.from, to: line.to, deco: HIDE });
      continue;
    }
    const isTable = /^\s*\|/.test(text);
    if (isTable && tableStart < 0) {
      tableStart = n;
      tableEnd = n;
      while (tableEnd < doc.lines && /^\s*\|/.test(doc.line(tableEnd + 1).text)) tableEnd++;
    }
    if (tableStart > 0 && n >= tableStart && n <= tableEnd) {
      const from = doc.line(tableStart).from;
      const to = doc.line(tableEnd).to;
      if (
        !active(from, to) &&
        parseTable(
          Array.from(
            { length: tableEnd - tableStart + 1 },
            (_, i) => doc.line(tableStart + i).text,
          ),
        )
      ) {
        ranges.push({
          from,
          to,
          deco: Decoration.replace({
            block: true,
            widget: new TableWidget(
              Array.from(
                { length: tableEnd - tableStart + 1 },
                (_, i) => doc.line(tableStart + i).text,
              ).join("\n"),
            ),
          }),
        });
        n = tableEnd;
      } else {
        ranges.push({ from: line.from, to: line.from, deco: TABLE });
        if (active(line.from, line.to))
          ranges.push({ from: line.from, to: line.from, deco: ACTIVE });
      }
      continue;
    }
    const lineActive = active(line.from, line.to);
    if (lineActive) {
      ranges.push({ from: line.from, to: line.from, deco: ACTIVE });
      continue;
    }
    const heading = text.match(/^(#{1,6})\s+/);
    if (heading?.[1]) {
      const level = heading[1].length;
      const deco = level === 1 ? H1 : level === 2 ? H2 : level === 3 ? H3 : H4;
      ranges.push({ from: line.from, to: line.from, deco });
      ranges.push({ from: line.from, to: line.from + heading[0].length, deco: HIDE });
    }
    const quote = text.match(/^(\s*>\s?)+/);
    if (quote?.[0]) {
      ranges.push({ from: line.from, to: line.from, deco: QUOTE });
      ranges.push({ from: line.from, to: line.from + quote[0].length, deco: HIDE });
    }
    const task = text.match(/^(\s*[-*+]\s+)\[([ xX])\]\s/);
    if (task?.[1] && task[2] !== undefined) {
      const boxFrom = line.from + task[1].length;
      const indent = text.match(/^\s*/)?.[0].length ?? 0;
      ranges.push({
        from: line.from + indent,
        to: boxFrom + 3,
        deco: Decoration.replace({
          widget: new CheckboxWidget(task[2].toLowerCase() === "x", boxFrom, boxFrom + 3),
        }),
      });
      if (task[2].toLowerCase() === "x")
        ranges.push({ from: boxFrom + 4, to: line.to, deco: MARKS.checked });
    }
    const rule = text.match(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/);
    if (rule) {
      ranges.push({
        from: line.from,
        to: line.to,
        deco: Decoration.replace({ widget: new RuleWidget() }),
      });
      continue;
    }
    for (const r of inlineRanges(text, line.from, false)) ranges.push(r);
  }

  // Replaces must not overlap; keep the first (left-most, widest) and drop the rest.
  const sorted = ranges.sort((a, b) => a.from - b.from || b.to - a.to);
  const kept: Range[] = [];
  for (const r of sorted) {
    if (kept.some((k) => r.from < k.to && r.to > k.from)) continue;
    kept.push(r);
  }
  const decos = kept.map((r) => r.deco.range(r.from, r.to));
  return Decoration.set(decos, true);
}

const livePreview = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update: (decorations, transaction) =>
    transaction.docChanged || transaction.selection
      ? buildDecorations(transaction.state)
      : decorations,
  provide: (field) => EditorView.decorations.from(field),
});

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "rgb(var(--foreground))" },
  ".cm-scroller": { overflow: "auto", fontFamily: '"IBM Plex Sans", sans-serif' },
  ".cm-gutters": { display: "none" },
  ".cm-content": { padding: "18px 0 40px", caretColor: "rgb(var(--foreground))" },
  ".cm-line": { padding: "0 18px", lineHeight: "1.65", fontSize: "16px" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "rgb(var(--primary) / 0.22)",
  },
  ".cm-cursor": { borderLeftColor: "rgb(var(--foreground))" },
  ".cm-placeholder": { color: "rgb(var(--muted-foreground))" },
  ".cm-live-active": { backgroundColor: "rgb(var(--surface-highest) / 0.35)" },
  ".cm-live-h1": { fontSize: "1.9em", fontWeight: "600", lineHeight: "1.25", marginTop: "0.6em" },
  ".cm-live-h2": { fontSize: "1.5em", fontWeight: "600", lineHeight: "1.3", marginTop: "0.6em" },
  ".cm-live-h3": { fontSize: "1.22em", fontWeight: "600", marginTop: "0.5em" },
  ".cm-live-h4": { fontSize: "1.05em", fontWeight: "600" },
  ".cm-live-strong": { fontWeight: "600" },
  ".cm-live-em": { fontStyle: "italic" },
  ".cm-live-strike": { textDecoration: "line-through" },
  ".cm-live-inline-code": {
    fontFamily: '"IBM Plex Mono", monospace',
    fontSize: "0.9em",
    backgroundColor: "rgb(var(--surface-high))",
    padding: "1px 3px",
    borderRadius: "3px",
  },
  ".cm-live-code": {
    fontFamily: '"IBM Plex Mono", monospace',
    fontSize: "13px",
    backgroundColor: "rgb(var(--surface-low))",
    borderLeft: "2px solid rgb(var(--border))",
  },
  ".cm-live-quote": {
    borderLeft: "3px solid rgb(var(--border))",
    color: "rgb(var(--muted-foreground))",
    paddingLeft: "4px",
  },
  ".cm-live-link": {
    color: "rgb(var(--primary))",
    textDecoration: "underline",
    textUnderlineOffset: "2px",
  },
  ".cm-live-wiki": { color: "rgb(var(--primary))" },
  ".cm-live-checked": { color: "rgb(var(--muted-foreground))", textDecoration: "line-through" },
  ".cm-live-task": {
    marginRight: "6px",
    accentColor: "rgb(var(--primary))",
    verticalAlign: "middle",
  },
  ".cm-live-image": { maxWidth: "100%", borderRadius: "6px", verticalAlign: "middle" },
  ".cm-live-remote": { color: "rgb(var(--primary))" },
  ".cm-live-rule": { border: 0, borderTop: "1px solid rgb(var(--border))", margin: "4px 18px" },
  ".cm-live-properties": {
    display: "inline-block",
    fontSize: "11px",
    letterSpacing: "0.02em",
    color: "rgb(var(--muted-foreground))",
    border: "1px solid rgb(var(--border))",
    borderRadius: "4px",
    padding: "1px 6px",
  },
  ".cm-live-table-wrap": { padding: "0 18px", overflowX: "auto" },
  ".cm-live-table": { borderCollapse: "collapse", width: "100%", fontSize: "14px" },
  ".cm-live-table th, .cm-live-table td": {
    border: "1px solid rgb(var(--border))",
    padding: "6px 8px",
  },
  ".cm-live-table th": { backgroundColor: "rgb(var(--surface-high))", fontWeight: "500" },
  ".cm-live-table-line": { fontFamily: '"IBM Plex Mono", monospace', fontSize: "13px" },
});

export function MarkdownLiveEditor({
  path,
  value,
  onChange,
  onSave,
  readOnly = false,
  testId = "code-editor-input",
  id,
  label,
  placeholder,
  height = "min(65dvh, 760px)",
  className,
  compact = false,
  onUploadImage,
}: MarkdownLiveEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const change = useRef(onChange);
  change.current = onChange;
  const save = useRef(onSave);
  save.current = onSave;
  const upload = useRef(onUploadImage);
  upload.current = onUploadImage;
  const fileInput = useRef<HTMLInputElement>(null);
  const [slash, setSlash] = useState<Slash | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashRef = useRef<Slash | null>(null);
  slashRef.current = slash;
  const indexRef = useRef(0);
  indexRef.current = slashIndex;
  const initial = useRef({ path, value, readOnly, testId, id, label, placeholder });
  const lineBreak = useRef(value.includes("\r\n") ? "\r\n" : "\n");

  function insertImage(file: File): void {
    const editor = view.current;
    if (!editor) return;
    const run = async () => {
      let url: string;
      if (upload.current) url = await upload.current(file);
      else
        url = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
      const alt = file.name.replace(/\.[^.]+$/, "");
      const snippet = `![${alt}](${url})`;
      editor.dispatch(editor.state.replaceSelection(snippet));
      editor.focus();
    };
    void run();
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: the editor is created once; command handlers read current refs
  useEffect(() => {
    if (!host.current) return;
    const original = initial.current;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: original.value,
        extensions: [
          basicSetup,
          markdown(),
          theme,
          livePreview,
          EditorState.readOnly.of(original.readOnly),
          EditorView.editable.of(!original.readOnly),
          EditorView.contentAttributes.of({
            "aria-label": original.label ?? `Edit ${original.path}`,
            "data-testid": original.testId,
            ...(original.id ? { id: original.id } : {}),
            ...(compact ? { "data-compact": "true" } : {}),
          }),
          original.placeholder ? editorPlaceholder(original.placeholder) : [],
          EditorView.lineWrapping,
          Prec.highest(
            keymap.of([
              {
                key: "Mod-s",
                run: () => {
                  save.current?.();
                  return true;
                },
              },
              {
                key: "Mod-b",
                run: () => {
                  wrap("**", "**", "bold text");
                  return true;
                },
              },
              {
                key: "Mod-i",
                run: () => {
                  wrap("*", "*", "italic text");
                  return true;
                },
              },
              {
                key: "Mod-k",
                run: () => {
                  wrap("[", "](url)", "link text");
                  return true;
                },
              },
              {
                key: "Enter",
                run: () => {
                  if (!slashRef.current) return false;
                  choose(SLASH_COMMANDS[indexRef.current]?.id ?? "h2");
                  return true;
                },
              },
              {
                key: "Tab",
                run: () => {
                  if (!slashRef.current) return false;
                  choose(SLASH_COMMANDS[indexRef.current]?.id ?? "h2");
                  return true;
                },
              },
              {
                key: "ArrowDown",
                run: () => {
                  if (!slashRef.current) return false;
                  setSlashIndex((i) => (i + 1) % filtered().length);
                  return true;
                },
              },
              {
                key: "ArrowUp",
                run: () => {
                  if (!slashRef.current) return false;
                  setSlashIndex((i) => (i - 1 + filtered().length) % filtered().length);
                  return true;
                },
              },
              {
                key: "Escape",
                run: () => {
                  if (!slashRef.current) return false;
                  setSlash(null);
                  return true;
                },
              },
              indentWithTab,
            ]),
          ),
          EditorView.updateListener.of((update) => {
            if (update.transactions.some((transaction) => transaction.annotation(externalChange)))
              return;
            if (update.docChanged) {
              lineBreak.current = update.state.doc.toString().includes("\r\n") ? "\r\n" : "\n";
              change.current?.(update.state.doc.toString().replace(/\r?\n/g, lineBreak.current));
            }
            const sel = update.state.selection.main;
            const line = update.state.doc.lineAt(sel.head);
            const before = update.state.sliceDoc(line.from, sel.head);
            const at = before.lastIndexOf("/");
            const match =
              at >= 0 && (at === 0 || /\s/.test(before[at - 1] ?? ""))
                ? before.slice(at + 1)
                : null;
            if (
              match !== null &&
              /^[a-z0-9 ]{0,20}$/i.test(match) &&
              !update.state.doc.lineAt(sel.head).text.trimStart().startsWith("```")
            ) {
              const coords = update.view.coordsAtPos(sel.head);
              const box = host.current?.getBoundingClientRect();
              if (coords && box)
                setSlash({
                  from: line.from + at,
                  to: sel.head,
                  query: match,
                  top: coords.bottom,
                  left: coords.left,
                });
            } else if (slashRef.current) setSlash(null);
          }),
          EditorView.domEventHandlers({
            paste: (event) => {
              const text = event.clipboardData?.getData("text/html");
              const file = [...(event.clipboardData?.files ?? [])].find((f) =>
                f.type.startsWith("image/"),
              );
              if (file) {
                event.preventDefault();
                insertImage(file);
                return true;
              }
              if (text) {
                const markdownText = htmlToMarkdown(text);
                if (markdownText) {
                  event.preventDefault();
                  view.current?.dispatch(view.current.state.replaceSelection(markdownText));
                  return true;
                }
              }
              return false;
            },
            drop: (event) => {
              const file = [...(event.dataTransfer?.files ?? [])].find((f) =>
                f.type.startsWith("image/"),
              );
              if (!file) return false;
              event.preventDefault();
              insertImage(file);
              return true;
            },
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      view.current = null;
      editor.destroy();
    };
  }, [compact]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    if (editor.state.doc.toString() === value.replace(/\r\n/g, "\n")) return;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: value },
      annotations: externalChange.of(true),
    });
  }, [value]);

  function filtered() {
    const q = (slashRef.current?.query ?? "").toLowerCase();
    return SLASH_COMMANDS.filter(
      (command) => command.label.toLowerCase().includes(q) || command.id.startsWith(q),
    );
  }

  function wrap(before: string, after: string, hint: string): void {
    const editor = view.current;
    if (!editor) return;
    const { from, to } = editor.state.selection.main;
    const selected = editor.state.sliceDoc(from, to);
    const text = selected || hint;
    editor.dispatch({
      changes: { from, to, insert: `${before}${text}${after}` },
      selection: {
        anchor: from + before.length,
        head: from + before.length + text.length,
      },
    });
    editor.focus();
  }

  function prefix(prefixText: string | ((i: number) => string)): void {
    const editor = view.current;
    if (!editor) return;
    const range = editor.state.selection.main;
    const start = editor.state.doc.lineAt(range.from).from;
    const endLine = editor.state.doc.lineAt(range.to).to;
    const block = editor.state.sliceDoc(start, endLine);
    const next = block
      .split("\n")
      .map((line, i) => {
        const clean = line.replace(/^(#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, "");
        return `${typeof prefixText === "function" ? prefixText(i) : prefixText}${clean}`;
      })
      .join("\n");
    editor.dispatch({
      changes: { from: start, to: endLine, insert: next },
      selection: { anchor: start + next.length },
    });
    editor.focus();
  }

  function block(text: string): void {
    const editor = view.current;
    if (!editor) return;
    const { from, to } = editor.state.selection.main;
    const atLine = editor.state.doc.lineAt(from);
    const before = from === atLine.from ? "" : "\n\n";
    const insert = `${before}${text}`;
    editor.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
    });
    editor.focus();
  }

  function choose(command: SlashCommand): void {
    const current = slashRef.current;
    const editor = view.current;
    if (!current || !editor) return;
    editor.dispatch({ changes: { from: current.from, to: current.to, insert: "" } });
    setSlash(null);
    switch (command) {
      case "h1":
      case "h2":
      case "h3":
        prefix(`${"#".repeat(Number(command[1]))} `);
        break;
      case "bullet":
        prefix("- ");
        break;
      case "ordered":
        prefix((i) => `${i + 1}. `);
        break;
      case "task":
        prefix("- [ ] ");
        break;
      case "quote":
        prefix("> ");
        break;
      case "fence":
        block("```\n\n```");
        break;
      case "table":
        block(tableTemplate());
        break;
      case "callout":
        block(calloutTemplate());
        break;
      case "divider":
        block("---");
        break;
      case "link":
        wrap("[", "](url)", "link text");
        break;
      case "image":
        fileInput.current?.click();
        break;
      case "wiki":
        wrap("[[", "]]", "Target");
        break;
    }
  }

  const choices = filtered();
  const activeIndex = Math.min(slashIndex, Math.max(0, choices.length - 1));
  return (
    <div
      data-testid="markdown-live-editor"
      data-path={path}
      className={cn(
        "relative flex min-h-0 min-w-0 flex-col overflow-hidden",
        compact ? "" : "rounded-md border border-surface-highest bg-surface",
        className,
      )}
      style={height ? { height } : undefined}
    >
      {!readOnly && (
        <div
          data-testid="markdown-toolbar"
          className={cn(
            "flex shrink-0 flex-wrap items-center gap-0.5 border-b border-surface-highest",
            compact ? "px-1 py-0.5" : "px-2 py-1",
          )}
        >
          <ToolbarButton label="Bold" onClick={() => wrap("**", "**", "bold text")}>
            <Bold size={14} />
          </ToolbarButton>
          <ToolbarButton label="Italic" onClick={() => wrap("*", "*", "italic text")}>
            <Italic size={14} />
          </ToolbarButton>
          <ToolbarButton label="Strikethrough" onClick={() => wrap("~~", "~~", "text")}>
            <Strikethrough size={14} />
          </ToolbarButton>
          <ToolbarButton label="Inline code" onClick={() => wrap("`", "`", "code")}>
            <Code2 size={14} />
          </ToolbarButton>
          <ToolbarButton label="Heading" onClick={() => prefix("## ")}>
            H2
          </ToolbarButton>
          <ToolbarButton label="Bulleted list" onClick={() => prefix("- ")}>
            <List size={14} />
          </ToolbarButton>
          <ToolbarButton label="Numbered list" onClick={() => prefix((i) => `${i + 1}. `)}>
            <ListOrdered size={14} />
          </ToolbarButton>
          <ToolbarButton label="Task list" onClick={() => prefix("- [ ] ")}>
            <ListTodo size={14} />
          </ToolbarButton>
          <ToolbarButton label="Quote" onClick={() => prefix("> ")}>
            <Quote size={14} />
          </ToolbarButton>
          <ToolbarButton label="Table" onClick={() => block(tableTemplate())}>
            <Table2 size={14} />
          </ToolbarButton>
          <ToolbarButton label="Link" onClick={() => wrap("[", "](url)", "link text")}>
            <Link2 size={14} />
          </ToolbarButton>
          <ToolbarButton label="Image" onClick={() => fileInput.current?.click()}>
            <ImagePlus size={14} />
          </ToolbarButton>
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
          <ToolbarButton
            label="Undo"
            onClick={() => {
              const editor = view.current;
              if (editor) {
                editor.focus();
                undo(editor);
              }
            }}
          >
            <Undo2 size={14} />
          </ToolbarButton>
          <ToolbarButton
            label="Redo"
            onClick={() => {
              const editor = view.current;
              if (editor) {
                editor.focus();
                redo(editor);
              }
            }}
          >
            <Redo2 size={14} />
          </ToolbarButton>
        </div>
      )}
      <div ref={host} className="min-h-0 min-w-0 flex-1 overflow-hidden" />
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        hidden
        data-testid="markdown-image-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) insertImage(file);
          event.target.value = "";
        }}
      />
      {slash && (
        <div
          data-testid="markdown-slash-menu"
          role="listbox"
          aria-label="Insert block"
          className="fixed z-[70] max-h-72 w-56 overflow-y-auto rounded-md border border-border bg-elevated p-1 shadow-xl"
          style={{ top: Math.min(slash.top + 4, window.innerHeight - 300), left: slash.left }}
          onMouseDown={(event) => event.preventDefault()}
        >
          {choices.length === 0 && <p className="px-2 py-1 text-xs text-outline">No blocks</p>}
          {choices.map((command, i) => (
            <button
              key={command.id}
              type="button"
              role="option"
              aria-selected={i === activeIndex}
              data-testid={`markdown-slash-${command.id}`}
              className={cn(
                "flex min-h-8 w-full items-center gap-2 rounded px-2 text-left text-sm",
                i === activeIndex ? "bg-surface-highest" : "hover:bg-surface-high",
              )}
              onMouseEnter={() => setSlashIndex(i)}
              onClick={() => choose(command.id)}
            >
              <span className="flex-1">{command.label}</span>
              <span className="font-mono text-xs text-outline">{command.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ToolbarButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      aria-label={label}
      title={label}
      className="h-7 min-w-7 px-1.5"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
