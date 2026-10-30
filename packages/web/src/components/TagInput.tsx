import { X } from "lucide-react";
import { type ClipboardEvent, type KeyboardEvent, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** Typing any of these ends a tag. */
const SEPARATOR = /[,\s]+/;

function merge(tags: string[], text: string): string[] {
  const added = text
    .split(SEPARATOR)
    .map((t) => t.trim())
    .filter(Boolean);
  return [...new Set([...tags, ...added])];
}

/**
 * Tags as removable chips. Enter, comma, space or Tab ends a tag, Backspace on an empty field
 * removes the last one, and pasted lists split into tags. Text left in the field becomes a tag
 * when the field loses focus, so a form submitted by clicking still includes it.
 */
export function TagInput({
  value,
  onChange,
  onDraftChange,
  suggestions = [],
  placeholder = "Add a label",
  "aria-label": ariaLabel,
  "data-testid": testId,
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  /** A form can protect text that has not yet been committed as a tag. */
  onDraftChange?: (draft: string) => void;
  suggestions?: string[];
  placeholder?: string;
  "aria-label": string;
  "data-testid"?: string;
}) {
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const offered = suggestions.filter((s) => !value.includes(s));

  function changeDraft(text: string) {
    setDraft(text);
    onDraftChange?.(text);
  }

  function commit(text: string) {
    const next = merge(value, text);
    if (next.length !== value.length) onChange(next);
    changeDraft("");
  }

  function type(text: string) {
    // A separator inside the text ends every tag before it; the rest stays as the draft.
    const parts = text.split(SEPARATOR);
    if (parts.length > 1) {
      const rest = parts.pop() ?? "";
      onChange(merge(value, parts.join(",")));
      changeDraft(rest);
    } else changeDraft(text);
  }

  function key(e: KeyboardEvent<HTMLInputElement>) {
    if ((e.key === "Enter" || e.key === "Tab") && draft.trim()) {
      e.preventDefault();
      commit(draft);
    } else if (e.key === "Backspace" && !draft && value.length > 0) {
      e.preventDefault();
      onChange(value.slice(0, -1));
    }
  }

  function paste(e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text");
    if (!SEPARATOR.test(text)) return;
    e.preventDefault();
    commit(`${draft},${text}`);
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: clicking the padding focuses the field, which has its own keyboard handling
    <div
      className={cn(
        "flex min-h-10 w-full cursor-text flex-wrap items-center gap-1.5 rounded-md border border-control-border bg-surface px-2 py-1.5 text-sm",
        "focus-within:ring-2 focus-within:ring-focus focus-within:ring-offset-2 ring-offset-background",
      )}
      onClick={() => input.current?.focus()}
    >
      {value.map((tag) => (
        <span
          key={tag}
          data-testid="tag-input-tag"
          className="inline-flex max-w-full items-center gap-1 rounded-full border border-outline-variant bg-surface-high py-0.5 pl-2.5 pr-1 text-xs text-on-surface"
        >
          <span className="truncate">{tag}</span>
          <button
            type="button"
            aria-label={`Remove ${tag}`}
            className="rounded-full p-0.5 text-outline hover:bg-surface-highest hover:text-on-surface focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus"
            onClick={(e) => {
              e.stopPropagation();
              onChange(value.filter((t) => t !== tag));
              input.current?.focus();
            }}
          >
            <X size={12} aria-hidden />
          </button>
        </span>
      ))}
      <input
        ref={input}
        aria-label={ariaLabel}
        data-testid={testId}
        list={offered.length > 0 ? listId : undefined}
        value={draft}
        onChange={(e) => type(e.target.value)}
        onKeyDown={key}
        onPaste={paste}
        onBlur={() => draft.trim() && commit(draft)}
        placeholder={value.length === 0 ? placeholder : ""}
        className="h-7 min-w-32 flex-1 bg-transparent px-1 outline-hidden placeholder:text-muted-foreground"
      />
      {offered.length > 0 && (
        <datalist id={listId}>
          {offered.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  );
}
