import type { ChatThread } from "@orc/core/chat";
import {
  Bookmark,
  Check,
  ClipboardCopy,
  Copy,
  GitFork,
  LoaderCircle,
  MessageSquareText,
  SquarePlus,
  TextCursor,
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import { ChatTurnMeta } from "@/components/ChatTurnMeta";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  boundedText,
  type ChatSelectionAction,
  isSelectionToolbarZone,
  MESSAGE_ACTION_LIMIT,
  markdownSelection,
  type SelectionSource,
} from "@/lib/chat-selection";
import { CLIPBOARD_ERROR, copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

const button =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-highest hover:text-on-surface focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-40 max-sm:size-11 pointer-coarse:size-11";
// Touch and coarse pointers keep both actions discoverable without hover.
const reveal =
  "opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100 pointer-coarse:opacity-100 max-md:opacity-100";

/** Arrow keys, Home and End move between the items of an open menu. */
function moveMenuFocus(event: React.KeyboardEvent<HTMLElement>) {
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'),
  ];
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next =
    event.key === "ArrowDown"
      ? (at + 1) % items.length
      : event.key === "ArrowUp"
        ? (at - 1 + items.length) % items.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : null;
  if (next === null || !items.length) return;
  event.preventDefault();
  items[next]?.focus();
}

function menuItem(
  testId: string,
  icon: React.ReactNode,
  label: string,
  onClick: () => void,
): React.ReactNode {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      onClick={onClick}
      className="flex min-h-11 w-full items-center gap-2 rounded px-2 text-left font-label text-[13px] text-on-surface hover:bg-surface-highest focus-visible:outline-2 focus-visible:outline-focus sm:min-h-8"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

export const ChatMessageActions = memo(function ChatMessageActions({
  threadId,
  messageId,
  role,
  content,
  turn,
  model,
  tokens,
  cachedTokens,
  forkDisabledReason,
  onForked,
  threadTitle,
  agent,
  timestamp,
  onSelectionAction,
}: {
  threadId: string | undefined;
  messageId: string;
  role: "user" | "assistant";
  content: string;
  turn: unknown;
  model?: string | undefined;
  tokens?: number | undefined;
  cachedTokens?: number | undefined;
  forkDisabledReason?: string | undefined;
  onForked: (thread: ChatThread) => void;
  threadTitle?: string | undefined;
  agent?: string | undefined;
  timestamp?: number | undefined;
  onSelectionAction?: (action: ChatSelectionAction, text: string, source: SelectionSource) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [forking, setForking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const actions = useRef<HTMLDivElement>(null);
  const selectedAtOpen = useRef<string>("");
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const source = (): SelectionSource => ({
    threadId,
    title: threadTitle ?? "New chat",
    agent: agent ?? "Assistant",
    timestamp: timestamp ?? Date.now(),
  });

  async function copy(): Promise<void> {
    if (await copyText(content)) {
      setCopied(true);
      setError(null);
    } else setError(CLIPBOARD_ERROR);
  }

  async function copyMarkdown(text: string): Promise<void> {
    if (await copyText(markdownSelection(text, source()))) {
      setCopied(true);
      setError(null);
    } else setError(CLIPBOARD_ERROR);
  }

  /**
   * The pointerdown that opens the menu can collapse the selection before the
   * item is clicked, so remember the text this message currently owns.
   */
  function captureSelection(): void {
    const root = actions.current?.closest('[data-testid="chat-message"]');
    const current = window.getSelection();
    if (!root || !current || current.isCollapsed || current.rangeCount === 0) {
      selectedAtOpen.current = "";
      return;
    }
    const anchor = current.anchorNode;
    const element =
      anchor?.nodeType === Node.ELEMENT_NODE
        ? (anchor as Element)
        : (anchor?.parentElement ?? null);
    selectedAtOpen.current =
      element && root.contains(element) && !isSelectionToolbarZone(element)
        ? current.toString()
        : "";
  }

  function runMenuAction(action: ChatSelectionAction | "copy"): void {
    const text = boundedText(selectedAtOpen.current || content, MESSAGE_ACTION_LIMIT);
    selectedAtOpen.current = "";
    setMenuOpen(false);
    if (!text) return;
    if (action === "copy") {
      void copyMarkdown(text);
      return;
    }
    onSelectionAction?.(action, text, source());
  }

  async function fork(): Promise<void> {
    if (!threadId) return;
    setForking(true);
    setError(null);
    try {
      onForked(await api.chat.fork(threadId, messageId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The session could not be forked.");
    } finally {
      setForking(false);
    }
  }

  const selectionMenu = content.trim() ? (
    <Popover open={menuOpen} onOpenChange={setMenuOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="chat-message-selection-menu"
          aria-label="Selection actions"
          aria-haspopup="menu"
          title="Selection actions"
          onPointerDown={captureSelection}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown")
              captureSelection();
          }}
          className={button}
        >
          <TextCursor aria-hidden="true" size={14} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        data-testid="chat-message-selection-actions"
        role="menu"
        aria-label="Selection actions"
        align="end"
        sideOffset={4}
        collisionPadding={8}
        className="z-50 w-52 rounded-md border border-outline-variant bg-surface-high p-1 shadow-lg"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement)
            .querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')
            ?.focus();
        }}
        onKeyDown={moveMenuFocus}
      >
        {menuItem(
          "chat-message-selection-ask",
          <MessageSquareText aria-hidden="true" size={14} />,
          "Ask about this",
          () => runMenuAction("ask"),
        )}
        {menuItem(
          "chat-message-selection-task",
          <SquarePlus aria-hidden="true" size={14} />,
          "Create task",
          () => runMenuAction("task"),
        )}
        {menuItem(
          "chat-message-selection-save",
          <Bookmark aria-hidden="true" size={14} />,
          "Save",
          () => runMenuAction("save"),
        )}
        {menuItem(
          "chat-message-selection-copy",
          <ClipboardCopy aria-hidden="true" size={14} />,
          "Copy as Markdown",
          () => runMenuAction("copy"),
        )}
      </PopoverContent>
    </Popover>
  ) : null;

  return (
    <div
      data-testid="chat-message-meta"
      className={cn(
        "flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-on-surface-variant",
        role === "user" && "justify-end",
      )}
    >
      {role === "assistant" && (
        <ChatTurnMeta turn={turn} model={model} tokens={tokens} cachedTokens={cachedTokens} />
      )}
      <div
        ref={actions}
        data-testid="chat-message-actions"
        className={cn("flex items-center gap-0.5", reveal)}
      >
        {content.trim() && (
          <button
            type="button"
            data-testid="chat-message-copy"
            aria-label={copied ? "Copied" : role === "user" ? "Copy your message" : "Copy response"}
            title={copied ? "Copied" : "Copy message"}
            onClick={() => void copy()}
            className={button}
          >
            {copied ? (
              <Check aria-hidden="true" size={14} />
            ) : (
              <Copy aria-hidden="true" size={14} />
            )}
          </button>
        )}
        {role === "assistant" && (
          <button
            type="button"
            data-testid="chat-message-fork"
            aria-label="Fork to new session"
            title={
              forkDisabledReason ??
              "Fork to a new session. Uses the agent's native session fork when supported."
            }
            disabled={!threadId || !!forkDisabledReason || forking}
            onClick={() => void fork()}
            className={button}
          >
            {forking ? (
              <LoaderCircle aria-hidden="true" size={14} className="motion-safe:animate-spin" />
            ) : (
              <GitFork aria-hidden="true" size={14} />
            )}
          </button>
        )}
        {selectionMenu}
      </div>
      {copied && (
        <span role="status" className="sr-only">
          Copied
        </span>
      )}
      {error && (
        <p role="alert" data-testid="chat-message-action-error" className="w-full text-error">
          {error}
        </p>
      )}
    </div>
  );
});
