import { Code2, Maximize2, Minimize2 } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { MarkdownLiveEditor } from "@/components/MarkdownLiveEditor";
import { SourceCodeEditor } from "@/components/SourceCodeEditor";
import { Button } from "@/components/ui/button";
import { splitMarkdownFrontmatter } from "@/lib/document-display";
import { isMarkdownFile } from "@/lib/file-kind";
import type { WikiLinks } from "@/lib/wiki-links";

type Mode = "read" | "edit" | "split";

export type MarkdownEditorProps = {
  path: string;
  value: string;
  onChange?: (value: string) => void;
  onSave?: () => void;
  readOnly?: boolean;
  testId?: string;
  wikiLinks?: WikiLinks;
  initialMode?: Mode;
  mode?: Mode;
  onModeChange?: (mode: Mode) => void;
  header?: ReactNode;
  height?: number | string;
  id?: string;
  label?: string;
  placeholder?: string;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /**
   * "frame" (default) is a fixed-height box. "page" flows with the surrounding scroll like an
   * article: the toolbar sticks and the editor grows with its content.
   */
  layout?: "frame" | "page";
  /** Controls placed at the end of the toolbar, such as save state. */
  actions?: ReactNode;
  /** Messages about the toolbar's actions, such as a failed save, shown right under it. */
  notice?: ReactNode;
  /** The title the page already shows; a leading H1 repeating it is not rendered again. */
  pageTitle?: string;
  /** Front matter is shown elsewhere as properties, so the preview leaves it out. */
  hideFrontmatter?: boolean;
  /** Compact form controls without removing the editor's modes or expansion. */
  compact?: boolean;
  line?: number;
  previewLinks?: boolean;
  /** Field embeddings keep their established test ids for the mode buttons and preview. */
  modeTestIdPrefix?: string;
  previewTestId?: string;
  className?: string;
  /** A form field fills its panel instead of keeping the document frame height. */
  fill?: boolean;
  /** Stores pasted images (KB asset endpoint); otherwise images embed as data URLs. */
  onUploadImage?: (file: File) => Promise<string>;
};

/** Drops a first-line `# Title` from the body when it repeats the page title. */
function withoutRepeatedTitle(body: string, title: string | undefined): string {
  if (!title) return body;
  const match = body.match(/^\s*#[ \t]+(.+?)[ \t#]*(?:\r?\n|$)/);
  const same = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  return match?.[1] && same(match[1]) === same(title) ? body.slice(match[0].length) : body;
}

export function MarkdownEditor({
  path,
  value,
  onChange,
  onSave,
  readOnly = false,
  testId,
  wikiLinks,
  initialMode,
  mode: controlledMode,
  onModeChange,
  header,
  height,
  id,
  label,
  placeholder,
  expanded: controlledExpanded,
  onExpandedChange,
  layout = "frame",
  actions,
  notice,
  pageTitle,
  hideFrontmatter = false,
  compact = false,
  line,
  previewLinks = false,
  modeTestIdPrefix,
  previewTestId,
  className,
  fill = false,
  onUploadImage,
}: MarkdownEditorProps) {
  const markdown = isMarkdownFile(path);
  const normalizedMode = (value: Mode | undefined): Mode =>
    value === "split" ? "edit" : (value ?? "read");
  const [localMode, setLocalMode] = useState<Mode>(
    normalizedMode(initialMode ?? (readOnly && markdown ? "read" : "edit")),
  );
  const mode = normalizedMode(controlledMode ?? localMode);
  const [source, setSource] = useState(false);
  useEffect(() => {
    if (line && line > 0) setLocalMode("edit");
  }, [line]);
  function setMode(next: Mode): void {
    setLocalMode(next);
    onModeChange?.(next);
  }
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = controlledExpanded ?? localExpanded;
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!expanded || !root.current) return;
    const changed: Array<{ element: HTMLElement; inert: boolean }> = [];
    let branch: HTMLElement = root.current;
    while (branch.parentElement) {
      const parent = branch.parentElement;
      for (const sibling of Array.from(parent.children)) {
        if (sibling === branch || !(sibling instanceof HTMLElement)) continue;
        changed.push({ element: sibling, inert: sibling.inert });
        sibling.inert = true;
      }
      if (parent.hasAttribute("data-document-container") || parent === document.body) break;
      branch = parent;
    }
    return () => {
      for (const item of changed) item.element.inert = item.inert;
    };
  }, [expanded]);
  function setExpanded(next: boolean): void {
    setLocalExpanded(next);
    onExpandedChange?.(next);
  }
  // Escape leaves fullscreen on any page. Inside a dialog or sheet, collapseExpandedDocument has
  // already used the key so the dialog stays open; a popup in the editor or a dialog over it
  // takes Escape first.
  useEffect(() => {
    if (!expanded) return;
    function leave(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]');
      if (dialog && !root.current?.contains(dialog)) return;
      setLocalExpanded(false);
      onExpandedChange?.(false);
    }
    window.addEventListener("keydown", leave);
    return () => window.removeEventListener("keydown", leave);
  }, [expanded, onExpandedChange]);
  const rendered = splitMarkdownFrontmatter(value);
  const body = withoutRepeatedTitle(rendered.body, pageTitle);
  const flowing = layout === "page" && markdown && !expanded;
  const style =
    expanded || flowing || fill
      ? undefined
      : {
          height: height ?? "min(65dvh, 760px)",
          minHeight: height || compact ? undefined : 280,
        };
  const modeId = (item: "read" | "edit") =>
    modeTestIdPrefix
      ? `${modeTestIdPrefix}-${item === "read" ? "preview" : "edit"}`
      : `markdown-mode-${item}`;
  return (
    <section
      ref={root}
      data-testid="markdown-editor"
      data-expanded={expanded}
      data-document-expanded={expanded}
      className={`flex min-w-0 flex-col ${flowing ? "" : "min-h-0 rounded-md border border-surface-highest bg-surface"} ${expanded ? "fixed inset-2 z-60 sm:inset-6" : ""} ${fill ? "min-h-0 flex-1 overflow-hidden" : ""} ${className ?? ""}`}
      style={style}
      aria-label={`Document ${path}`}
      onKeyDown={(event) => {
        if (event.defaultPrevented) return;
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          onSave?.();
        }
      }}
    >
      {header && <div className="shrink-0 border-b border-surface-highest p-3">{header}</div>}
      <div
        className={`flex shrink-0 flex-wrap items-center ${compact ? "gap-1" : "gap-2"} border-b border-surface-highest ${flowing ? "sticky top-0 z-10 bg-background py-2" : compact ? "px-2 py-1" : "p-2"}`}
      >
        {markdown && (
          <fieldset className="flex gap-1" aria-label="Document mode">
            {(["read", "edit"] as const).map((item) => (
              <Button
                key={item}
                type="button"
                size="sm"
                variant={!compact && mode === item ? "default" : "ghost"}
                className={`${compact && mode === item ? "bg-surface-highest text-on-surface" : ""}`}
                data-testid={modeId(item)}
                aria-pressed={mode === item}
                onClick={() => setMode(item)}
              >
                {item === "read" ? "Read" : readOnly ? "Source" : "Edit"}
              </Button>
            ))}
            {mode === "edit" && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                data-testid="markdown-mode-source"
                aria-pressed={source}
                className={compact && source ? "bg-surface-highest text-on-surface" : ""}
                onClick={() => setSource(!source)}
              >
                <Code2 size={13} />
                {source ? "Live preview" : "Source"}
              </Button>
            )}
          </fieldset>
        )}
        <span className="min-w-0 flex-1 truncate px-1 text-xs text-outline" title={path}>
          {layout === "page" || compact ? "" : path}
        </span>
        {actions}
        {expanded && onSave && !header && !actions && (
          <Button type="button" data-testid="markdown-save" disabled={readOnly} onClick={onSave}>
            Save
          </Button>
        )}
        <Button
          type="button"
          size="icon"
          variant="ghost"
          data-testid="markdown-expand"
          aria-label={expanded ? "Exit fullscreen" : "Expand editor"}
          aria-pressed={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </Button>
      </div>
      {notice && (
        <div
          className={`shrink-0 space-y-1 border-b border-surface-highest ${flowing ? "py-2" : "p-3"}`}
        >
          {notice}
        </div>
      )}
      <div
        className={`min-h-0 min-w-0 flex-1 ${flowing ? "pt-2" : "overflow-hidden"} ${mode === "read" && markdown ? "hidden" : ""}`}
      >
        <div
          className={`min-h-0 min-w-0 h-full ${flowing ? "[&_.cm-editor]:min-h-[50dvh]" : "overflow-hidden"}`}
        >
          {source ? (
            <SourceCodeEditor
              line={line}
              path={path}
              value={value}
              onChange={onChange}
              onSave={onSave}
              readOnly={readOnly}
              height="100%"
              testId={testId}
              hidePreview
              defaultWrap
              id={id}
              label={label}
              placeholder={placeholder}
            />
          ) : (
            <MarkdownLiveEditor
              path={path}
              value={value}
              onChange={onChange}
              onSave={onSave}
              readOnly={readOnly}
              testId={testId}
              id={id}
              label={label}
              placeholder={placeholder}
              height={flowing ? undefined : "100%"}
              compact={compact}
              onUploadImage={onUploadImage}
              className={flowing ? "min-h-[50dvh]" : fill ? "h-full" : undefined}
            />
          )}
        </div>
      </div>
      {markdown && mode !== "edit" && (
        <article
          data-testid={previewTestId ?? "markdown-preview"}
          aria-label="Rendered Markdown"
          className={`min-h-0 min-w-0 ${flowing ? "px-1 pb-6 pt-4" : "overflow-auto p-4 sm:p-8"}`}
        >
          {/* A page uses the full column; a frame centers the document at a reading measure. */}
          <div className={`wrap-break-word ${flowing ? "" : "mx-auto max-w-[76ch]"}`}>
            {rendered.metadata !== null && !hideFrontmatter && (
              <details className="mb-5 rounded border border-surface-highest p-3 text-sm text-outline">
                <summary className="cursor-pointer">Document metadata</summary>
                <pre className="mt-3 whitespace-pre-wrap wrap-break-word font-mono text-xs">
                  {rendered.metadata}
                </pre>
              </details>
            )}
            {value.trim() ? (
              <Markdown readable wikiLinks={wikiLinks} previewLinks={previewLinks}>
                {body}
              </Markdown>
            ) : (
              <p className="text-sm text-outline">This document is empty</p>
            )}
          </div>
        </article>
      )}
    </section>
  );
}
