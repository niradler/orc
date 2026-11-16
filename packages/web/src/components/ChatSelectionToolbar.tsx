import { Bookmark, Check, ClipboardCopy, Copy, MessageSquareText, SquarePlus } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  boundedText,
  type ChatSelectionAction,
  isSelectionToolbarZone,
  markdownSelection,
  SELECTION_CAPTURE_LIMIT,
  type SelectionSource,
} from "@/lib/chat-selection";
import { CLIPBOARD_ERROR, copyText } from "@/lib/clipboard";

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface SelectionSnapshot {
  text: string;
  source: SelectionSource;
  rect: Rect;
}

const actionClass =
  "inline-flex min-h-8 items-center gap-1.5 rounded px-2 font-label text-[13px] text-on-surface hover:bg-surface-highest focus-visible:outline-2 focus-visible:outline-focus max-sm:min-h-11 max-sm:px-2.5 pointer-coarse:min-h-11";

function elementFor(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/**
 * A transient toolbar over a text selection in a message. It is one presentation
 * of the actions; every action is also in the message actions menu. Selection
 * capture is read-only and stays out of text fields and the terminal layer.
 */
export function ChatSelectionToolbar({
  resetKey,
  resolveSource,
  onAction,
}: {
  /** Thread id; a new conversation dismisses a toolbar left from the last one. */
  resetKey: string | undefined;
  resolveSource: (messageId: string) => SelectionSource;
  onAction: (action: ChatSelectionAction, text: string, source: SelectionSource) => void;
}) {
  const [selection, setSelection] = useState<SelectionSnapshot | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [copied, setCopied] = useState<"text" | "markdown" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const copyTimer = useRef<number | undefined>(undefined);

  const hide = useCallback(() => setSelection(null), []);

  const lastKey = useRef(resetKey);
  useEffect(() => {
    if (lastKey.current === resetKey) return;
    lastKey.current = resetKey;
    setSelection(null);
  }, [resetKey]);

  useEffect(() => {
    let frame = 0;
    const read = () => {
      frame = 0;
      if (composing.current) return hide();
      // A dialog or open menu owns the screen; a toolbar over it would be unreachable.
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]'))
        return hide();
      const current = window.getSelection();
      if (!current || current.isCollapsed || current.rangeCount === 0) return hide();
      const raw = current.toString();
      if (!raw.trim()) return hide();
      const range = current.getRangeAt(0);
      const start = elementFor(range.startContainer);
      const end = elementFor(range.endContainer) ?? start;
      if (!start || !end) return hide();
      const message = start.closest('[data-testid="chat-message"]');
      if (!message) return hide();
      // A drag that starts in one message and ends in another is not a quote of
      // either; a selection that trails into chat chrome (the live announcer) is.
      const endMessage = end.closest('[data-testid="chat-message"]');
      if (endMessage && endMessage !== message) return hide();
      if (isSelectionToolbarZone(start) || isSelectionToolbarZone(end)) return hide();
      const rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) return hide();
      const text = boundedText(raw, SELECTION_CAPTURE_LIMIT);
      if (!text) return hide();
      const messageId = message.getAttribute("data-message-id") ?? "";
      setSelection({
        text,
        source: resolveSource(messageId),
        rect: {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        },
      });
    };
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(read);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && toolbar.current?.contains(event.target)) return;
      hide();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // Only clear a selection this toolbar owns; the terminal's own selection
      // must keep its native Escape behavior.
      if (event.key !== "Escape" || !toolbar.current) return;
      hide();
      window.getSelection()?.removeAllRanges();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "Escape") schedule();
    };
    const onCompositionStart = () => {
      composing.current = true;
      hide();
    };
    const onCompositionEnd = () => {
      composing.current = false;
    };

    document.addEventListener("selectionchange", schedule);
    document.addEventListener("pointerup", schedule);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("scroll", hide, true);
    document.addEventListener("compositionstart", onCompositionStart);
    document.addEventListener("compositionend", onCompositionEnd);
    window.addEventListener("resize", hide);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("pointerup", schedule);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("scroll", hide, true);
      document.removeEventListener("compositionstart", onCompositionStart);
      document.removeEventListener("compositionend", onCompositionEnd);
      window.removeEventListener("resize", hide);
    };
  }, [hide, resolveSource]);

  useEffect(() => {
    if (!copied) return;
    copyTimer.current = window.setTimeout(() => setCopied(null), 2000);
    return () => window.clearTimeout(copyTimer.current);
  }, [copied]);

  useLayoutEffect(() => {
    if (!selection) {
      setPosition(null);
      return;
    }
    const node = toolbar.current;
    if (!node) return;
    const margin = 8;
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    const left = Math.max(
      margin,
      Math.min(
        selection.rect.left + selection.rect.width / 2 - width / 2,
        window.innerWidth - width - margin,
      ),
    );
    const above = selection.rect.top - height - 8;
    // Flip below when the selection sits at the top of the viewport.
    const top =
      above >= margin
        ? above
        : Math.min(selection.rect.bottom + 8, window.innerHeight - height - margin);
    setPosition({ left, top: Math.max(margin, top) });
  }, [selection]);

  if (!selection) return null;

  const act = (action: ChatSelectionAction) => {
    if (!selection) return;
    onAction(action, selection.text, selection.source);
    setSelection(null);
  };

  const copy = async (format: "text" | "markdown") => {
    if (!selection) return;
    const ok = await copyText(
      format === "markdown" ? markdownSelection(selection.text, selection.source) : selection.text,
    );
    if (ok) {
      setCopied(format);
      setError(null);
    } else setError(CLIPBOARD_ERROR);
  };

  return createPortal(
    <div
      ref={toolbar}
      role="toolbar"
      aria-label="Selection actions"
      data-testid="chat-selection-toolbar"
      style={{
        left: position?.left ?? selection.rect.left,
        top: position?.top ?? selection.rect.top,
        visibility: position ? "visible" : "hidden",
      }}
      className="fixed z-50 flex max-w-[calc(100vw-16px)] flex-wrap items-center gap-0.5 rounded-md border border-outline-variant bg-surface-high p-1 shadow-lg"
      onPointerDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        data-testid="chat-selection-ask"
        aria-label="Ask about this"
        title="Ask about this"
        className={actionClass}
        onClick={() => act("ask")}
      >
        <MessageSquareText aria-hidden="true" size={14} />
        <span>Ask</span>
      </button>
      <button
        type="button"
        data-testid="chat-selection-task"
        aria-label="Create task"
        title="Create task"
        className={actionClass}
        onClick={() => act("task")}
      >
        <SquarePlus aria-hidden="true" size={14} />
        <span>Task</span>
      </button>
      <button
        type="button"
        data-testid="chat-selection-copy"
        aria-label={copied === "text" ? "Copied" : "Copy"}
        title="Copy"
        className={actionClass}
        onClick={() => void copy("text")}
      >
        {copied === "text" ? (
          <Check aria-hidden="true" size={14} />
        ) : (
          <Copy aria-hidden="true" size={14} />
        )}
        <span>Copy</span>
      </button>
      <button
        type="button"
        data-testid="chat-selection-copy-md"
        aria-label={copied === "markdown" ? "Copied as Markdown" : "Copy as Markdown"}
        title="Copy as Markdown with its source"
        className={actionClass}
        onClick={() => void copy("markdown")}
      >
        {copied === "markdown" ? (
          <Check aria-hidden="true" size={14} />
        ) : (
          <ClipboardCopy aria-hidden="true" size={14} />
        )}
        <span>Copy MD</span>
      </button>
      <button
        type="button"
        data-testid="chat-selection-save"
        aria-label="Save"
        title="Save"
        className={actionClass}
        onClick={() => act("save")}
      >
        <Bookmark aria-hidden="true" size={14} />
        <span>Save</span>
      </button>
      {copied && (
        <span role="status" className="sr-only">
          {copied === "markdown" ? "Copied as Markdown" : "Copied"}
        </span>
      )}
      {error && (
        <p
          role="alert"
          data-testid="chat-selection-error"
          className="w-full px-2 pb-1 text-xs text-error"
        >
          {error}
        </p>
      )}
    </div>,
    document.body,
  );
}
