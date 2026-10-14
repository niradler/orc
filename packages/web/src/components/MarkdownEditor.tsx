import { Maximize2, Minimize2 } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { SourceCodeEditor } from "@/components/SourceCodeEditor";
import { Button } from "@/components/ui/button";
import { splitMarkdownFrontmatter } from "@/lib/document-display";
import { isMarkdownFile } from "@/lib/editor-language";

type Mode = "read" | "edit" | "split";

export type MarkdownEditorProps = {
  path: string;
  value: string;
  onChange?: (value: string) => void;
  onSave?: () => void;
  readOnly?: boolean;
  testId?: string;
  wikiLinks?: { slugs: string[]; select: (slug: string) => void };
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
};

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
}: MarkdownEditorProps) {
  const markdown = isMarkdownFile(path);
  const [localMode, setLocalMode] = useState<Mode>(
    initialMode ?? (readOnly && markdown ? "read" : "edit"),
  );
  const mode = controlledMode ?? localMode;
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
  const rendered = splitMarkdownFrontmatter(value);
  return (
    <section
      ref={root}
      data-testid="markdown-editor"
      data-expanded={expanded}
      data-document-expanded={expanded}
      className={`flex min-h-0 min-w-0 flex-col rounded-md border border-surface-highest bg-surface ${expanded ? "fixed inset-2 z-[60] sm:inset-6" : ""}`}
      style={
        expanded
          ? undefined
          : { height: height ?? "min(65dvh, 760px)", minHeight: height ? undefined : 280 }
      }
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
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-surface-highest p-2">
        {markdown && (
          <fieldset className="flex gap-1" aria-label="Document mode">
            {(["read", "edit", "split"] as const).map((item) => (
              <Button
                key={item}
                type="button"
                size="sm"
                variant={mode === item ? "default" : "ghost"}
                data-testid={`markdown-mode-${item}`}
                aria-pressed={mode === item}
                onClick={() => setMode(item)}
              >
                {item === "read"
                  ? "Read"
                  : item === "edit"
                    ? readOnly
                      ? "Source"
                      : "Edit"
                    : "Split"}
              </Button>
            ))}
          </fieldset>
        )}
        <span className="min-w-0 flex-1 truncate px-1 text-xs text-outline" title={path}>
          {path}
        </span>
        {expanded && onSave && !header && (
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
      <div
        className={`grid min-h-0 min-w-0 flex-1 overflow-hidden ${mode === "split" && markdown ? "grid-rows-2 md:grid-cols-2 md:grid-rows-1" : "grid-cols-1"}`}
      >
        <div
          className={`min-h-0 min-w-0 overflow-hidden ${mode === "read" && markdown ? "hidden" : ""}`}
        >
          <SourceCodeEditor
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
        </div>
        {markdown && mode !== "edit" && (
          <article
            data-testid="markdown-preview"
            aria-label="Rendered Markdown"
            className={`min-h-0 min-w-0 overflow-auto p-4 sm:p-8 ${mode === "split" ? "border-t border-surface-highest md:border-l md:border-t-0" : ""}`}
          >
            <div className="mx-auto max-w-[76ch] break-words">
              {rendered.metadata !== null && (
                <details className="mb-5 rounded border border-surface-highest p-3 text-sm text-outline">
                  <summary className="cursor-pointer">Document metadata</summary>
                  <pre className="mt-3 whitespace-pre-wrap break-words font-mono text-xs">
                    {rendered.metadata}
                  </pre>
                </details>
              )}
              {value.trim() ? (
                <Markdown readable wikiLinks={wikiLinks}>
                  {rendered.body}
                </Markdown>
              ) : (
                <p className="text-sm text-outline">This document is empty.</p>
              )}
            </div>
          </article>
        )}
      </div>
    </section>
  );
}
