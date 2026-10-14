import { ComposerPrimitive, MessagePrimitive, ThreadPrimitive } from "@assistant-ui/react";
import { ArrowDown, ArrowUp, MessageSquare, Square, Trash2, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Markdown } from "@/components/Markdown";
import { useChat } from "@/hooks/useChat";
import { useBreakpoint } from "@/hooks/useMediaQuery";
import { usePanelWidth } from "@/hooks/usePanelWidth";
import { cn } from "@/lib/utils";

interface ChatPanelProps {
  open: boolean;
  onToggle: () => void;
  embedded?: boolean;
  onClose?: () => void;
}
const iconButton =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface-highest hover:text-on-surface disabled:opacity-40";
const textParts = { Text: ({ text }: { text: string }) => <Markdown>{text}</Markdown> };

export function ChatPanel({ open, onToggle, embedded = false, onClose }: ChatPanelProps) {
  const { messages, streaming, streamingAgent, error, config, setConfig, clear } = useChat();
  const input = useRef<HTMLTextAreaElement>(null);
  const desktop = useBreakpoint("md");
  const panel = usePanelWidth({
    storageKey: "orc_chat_panel_width",
    initial: 384,
    min: 288,
    max: 640,
    edge: "left",
  });
  useEffect(() => {
    if (open && (embedded ? !desktop : desktop)) input.current?.focus();
  }, [open, embedded, desktop]);
  const agents = Array.from(new Set(["codex", "claude", "gemini", "copilot", config.agent]));
  if ((!open && !embedded) || (embedded ? desktop : !desktop))
    return <div data-testid="chat-panel-collapsed" className="hidden" />;
  return (
    <ThreadPrimitive.Root
      data-testid="chat-panel"
      data-streaming={streaming ? "true" : "false"}
      style={embedded ? undefined : { width: panel.width, maxWidth: "50vw" }}
      className={cn(
        "relative h-full flex min-h-0 flex-col bg-surface",
        embedded ? "w-full" : "shrink-0 border-l border-outline-variant",
      )}
    >
      {!embedded && (
        // biome-ignore lint/a11y/useSemanticElements: pointer-driven splitter has no native element
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat panel"
          aria-valuenow={panel.width}
          aria-valuemin={288}
          aria-valuemax={640}
          tabIndex={0}
          data-testid="chat-panel-resize"
          title="Drag to resize, double-click to reset"
          className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none hover:bg-primary/30 focus-visible:bg-primary/40 focus-visible:outline-none"
          {...panel.handleProps}
        />
      )}
      <header className="shrink-0 border-b border-outline-variant px-4 py-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MessageSquare size={18} className="text-primary" />
            <h2 className="text-sm font-semibold">Agent chat</h2>
          </div>
          <button
            type="button"
            onClick={onClose ?? onToggle}
            className={iconButton}
            aria-label="Close chat"
          >
            <X size={18} />
          </button>
        </div>
        <label className="flex items-center gap-2 text-sm text-on-surface-variant">
          <span>Agent</span>
          <select
            data-testid="chat-agent-select"
            aria-label="Chat agent"
            value={config.agent}
            onChange={(event) => setConfig({ ...config, agent: event.target.value })}
            className="min-w-0 flex-1 min-h-11 rounded-md bg-surface-low px-2 text-base sm:text-sm text-on-surface disabled:opacity-50"
          >
            {agents.map((agent) => (
              <option key={agent} value={agent}>
                {agent}
              </option>
            ))}
          </select>
        </label>
      </header>
      <ThreadPrimitive.Viewport
        data-testid="chat-messages"
        className="relative flex-1 min-h-0 overflow-y-auto px-4 py-5"
      >
        {messages.length === 0 && !streaming && (
          <div className="flex h-full flex-col justify-center gap-2">
            <h3 className="text-lg font-medium">What are you working on?</h3>
            <p className="max-w-xs text-sm leading-relaxed text-on-surface-variant">
              Ask about your tasks, review agent activity, or work through a coding question.
            </p>
          </div>
        )}
        <ThreadPrimitive.Messages>
          {({ message }) => (
            <MessagePrimitive.Root
              data-testid="chat-message"
              data-role={message.role}
              className={cn(
                "mb-6 min-w-0 text-sm leading-relaxed",
                message.role === "user" && "rounded-xl bg-surface-low px-3 py-3",
              )}
            >
              <div
                data-testid="chat-message-agent"
                className="mb-2 text-xs font-medium text-on-surface-variant"
              >
                {message.role === "user"
                  ? "You"
                  : typeof message.metadata.custom.agent === "string"
                    ? message.metadata.custom.agent
                    : "Assistant"}
              </div>
              <div data-testid="chat-message-content" className="min-w-0 break-words">
                <MessagePrimitive.Parts components={textParts} />
              </div>
            </MessagePrimitive.Root>
          )}
        </ThreadPrimitive.Messages>
      </ThreadPrimitive.Viewport>
      {streaming && (
        <p role="status" className="shrink-0 px-4 py-2 text-xs text-on-surface-variant">
          {streamingAgent} is responding…
        </p>
      )}
      {error && (
        <div
          role="alert"
          data-testid="chat-error"
          className="shrink-0 max-h-32 overflow-auto border-t border-error/30 bg-error/10 px-4 py-3 text-sm text-error break-words"
        >
          {error}
        </div>
      )}
      <div className="shrink-0 px-3 pt-2 pb-3">
        <ThreadPrimitive.ScrollToBottom
          aria-label="Scroll to latest response"
          className="mx-auto mb-2 flex min-h-9 items-center gap-1 rounded-full border border-outline-variant bg-surface px-3 text-xs text-on-surface-variant disabled:hidden"
        >
          <ArrowDown size={14} />
          Latest response
        </ThreadPrimitive.ScrollToBottom>
        <ComposerPrimitive.Root className="rounded-xl border border-outline-variant bg-background p-2 focus-within:border-primary">
          <ComposerPrimitive.Input
            ref={input}
            data-testid="chat-input"
            aria-label="Message your agent"
            placeholder="Message your agent…"
            disabled={streaming}
            submitMode="enter"
            unstable_insertNewlineOnTouchEnter
            rows={2}
            className="w-full resize-none bg-transparent p-2 text-base sm:text-sm leading-relaxed placeholder:text-on-surface-variant focus-visible:outline-none disabled:opacity-60"
          />
          <div className="flex items-center justify-end sm:justify-between gap-2">
            <span className="hidden sm:block px-2 text-xs text-on-surface-variant">
              Shift + Enter for a new line
            </span>
            {streaming ? (
              <ComposerPrimitive.Cancel
                data-testid="chat-cancel-button"
                aria-label="Stop response"
                className={iconButton}
              >
                <Square size={17} />
              </ComposerPrimitive.Cancel>
            ) : (
              <ComposerPrimitive.Send
                data-testid="chat-send-button"
                aria-label="Send message"
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg bg-primary text-primary-foreground disabled:opacity-40"
              >
                <ArrowUp size={18} />
              </ComposerPrimitive.Send>
            )}
          </div>
        </ComposerPrimitive.Root>
        <div className="mt-2 flex items-center justify-end gap-2">
          <button
            type="button"
            data-testid="chat-clear-button"
            onClick={clear}
            aria-label="Clear conversation"
            title="Clear conversation"
            className={iconButton}
          >
            <Trash2 size={16} />
            <span className="ml-2 text-xs">Clear conversation</span>
          </button>
        </div>
      </div>
    </ThreadPrimitive.Root>
  );
}
