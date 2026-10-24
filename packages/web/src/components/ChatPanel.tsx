import { ComposerPrimitive, MessagePrimitive, ThreadPrimitive } from "@assistant-ui/react";
import {
  ArrowDown,
  ArrowUp,
  LoaderCircle,
  Maximize2,
  MessageSquare,
  Minimize2,
  Plus,
  Square,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { AgentMessageText } from "@/components/AgentMessageText";
import { ChatActivityList } from "@/components/ChatActivityList";
import { ChatContinueInTerminal } from "@/components/ChatContinueInTerminal";
import {
  ChatConversationInfo,
  ChatModelPicker,
  ChatSessionPicker,
} from "@/components/ChatControls";
import { ChatQuestionForm } from "@/components/ChatQuestionForm";
import { useChat } from "@/hooks/useChat";
import { usePanelWidth } from "@/hooks/usePanelWidth";
import { cn } from "@/lib/utils";

interface ChatPanelProps {
  open: boolean;
  onToggle: () => void;
  embedded?: boolean;
  onClose?: () => void;
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
}
const iconButton =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface hover:text-on-surface disabled:opacity-40";
const textParts = {
  Text: ({ text }: { text: string }) => <AgentMessageText>{text}</AgentMessageText>,
};

export function ChatPanel({
  open,
  onToggle,
  embedded = false,
  onClose,
  fullscreen = false,
  onToggleFullscreen,
}: ChatPanelProps) {
  const {
    messages,
    streaming,
    streamingAgent,
    error,
    config,
    setConfig,
    clear,
    ready,
    thread,
    historyBefore,
    loadingHistory,
    loadOlder,
    permission,
    respondPermission,
    question,
    respondQuestion,
    responding,
  } = useChat();
  const input = useRef<HTMLTextAreaElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const historyAnchor = useRef<{ height: number; top: number; threadId: string } | null>(null);
  useLayoutEffect(() => {
    const anchor = historyAnchor.current;
    const element = viewport.current;
    if (loadingHistory || !anchor || !element) return;
    if (anchor.threadId === thread?.id)
      element.scrollTop = anchor.top + element.scrollHeight - anchor.height;
    historyAnchor.current = null;
  }, [loadingHistory, thread?.id]);
  const panel = usePanelWidth({
    storageKey: "orc_chat_panel_width",
    initial: 384,
    min: 288,
    max: 640,
    edge: "left",
  });
  useEffect(() => {
    if (open && !embedded) input.current?.focus();
  }, [open, embedded]);
  const agents = Array.from(new Set(["codex", "claude", "gemini", "copilot", config.agent]));
  if (!open) return <div data-testid="chat-panel-collapsed" className="hidden" />;
  return (
    <ThreadPrimitive.Root
      data-testid="chat-panel"
      data-streaming={streaming ? "true" : "false"}
      style={embedded ? undefined : { width: panel.width, maxWidth: "50vw" }}
      className={cn(
        "relative h-full flex min-h-0 flex-col bg-background",
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
          className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none hover:bg-surface-highest focus-visible:bg-focus"
          {...panel.handleProps}
        />
      )}
      <header className="chat-header shrink-0 border-b border-outline-variant px-4 py-2">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <MessageSquare size={18} className="text-primary" />
            <h2 className="text-sm font-medium">Chat</h2>
          </div>
          <div className="flex items-center">
            <ChatContinueInTerminal key={thread?.id ?? "new"} />
            <ChatConversationInfo />
            <ChatSessionPicker />
            {onToggleFullscreen && (
              <button
                type="button"
                data-testid="chat-fullscreen-button"
                onClick={onToggleFullscreen}
                className={`${iconButton} hidden xl:inline-flex`}
                aria-label={fullscreen ? "Exit full screen chat" : "Full screen chat"}
                title={fullscreen ? "Exit full screen" : "Full screen"}
              >
                {fullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
              </button>
            )}
            <button
              type="button"
              onClick={onClose ?? onToggle}
              data-testid="chat-close-button"
              className={iconButton}
              aria-label="Close chat"
            >
              <X size={18} />
            </button>
          </div>
        </div>
        <div className="chat-header-controls mx-auto mt-1 grid w-full max-w-3xl grid-cols-2 items-start gap-2">
          <label className="flex min-w-0 flex-1 items-center text-sm text-on-surface-variant">
            <span className="sr-only">Agent</span>
            <select
              data-testid="chat-agent-select"
              aria-label="Chat agent"
              value={config.agent}
              disabled={streaming || !!thread || !ready}
              onChange={(event) => setConfig({ ...config, agent: event.target.value, model: "" })}
              className="min-w-0 flex-1 min-h-11 rounded-md border border-control-border bg-background px-2 text-base sm:text-sm text-on-surface disabled:opacity-50"
            >
              {agents.map((agent) => (
                <option key={agent} value={agent}>
                  {agent}
                </option>
              ))}
            </select>
          </label>
          <ChatModelPicker key={`${thread?.id ?? "new"}:${config.agent}`} />
        </div>
      </header>
      <ThreadPrimitive.Viewport
        ref={viewport}
        data-testid="chat-messages"
        className="relative flex-1 min-h-0 overflow-y-auto px-4 py-5"
      >
        {historyBefore !== null && (
          <button
            type="button"
            data-testid="chat-load-older"
            disabled={loadingHistory || streaming}
            className="mx-auto mb-4 block min-h-11 rounded-md border border-border px-3 text-sm text-primary hover:bg-surface disabled:opacity-50"
            onClick={() => {
              const element = viewport.current;
              if (element && thread)
                historyAnchor.current = {
                  height: element.scrollHeight,
                  top: element.scrollTop,
                  threadId: thread.id,
                };
              void loadOlder();
            }}
          >
            {loadingHistory ? "Loading older messages…" : "Load older messages"}
          </button>
        )}
        {messages.length === 0 && !streaming && (
          <div className="mx-auto flex h-full w-full max-w-3xl flex-col justify-center gap-2">
            <h3 className="text-lg font-medium">What are you working on?</h3>
            <p className="max-w-xs text-sm leading-relaxed text-on-surface-variant">
              Ask about your tasks, review agent activity, or work through a coding question.
            </p>
          </div>
        )}
        <ThreadPrimitive.Messages>
          {({ message }) => (
            <MessagePrimitive.Root
              style={{ contentVisibility: "auto", containIntrinsicSize: "auto 120px" }}
              data-testid="chat-message"
              data-role={message.role}
              className={cn(
                "mx-auto mb-6 w-full max-w-3xl min-w-0 text-sm leading-relaxed",
                message.role === "user" && "rounded-lg bg-surface px-3 py-3",
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
                <ChatActivityList value={message.metadata.custom.activity} />
                <MessagePrimitive.Parts components={textParts} />
              </div>
            </MessagePrimitive.Root>
          )}
        </ThreadPrimitive.Messages>
      </ThreadPrimitive.Viewport>
      {streaming && (
        <p
          role="status"
          data-testid="chat-activity-status"
          className="flex shrink-0 items-center gap-2 px-4 py-2 text-xs text-on-surface-variant"
        >
          <LoaderCircle size={14} aria-hidden="true" className="animate-spin" />
          {streamingAgent} is responding…
        </p>
      )}
      {error && (
        <div
          role="alert"
          data-testid="chat-error"
          className="shrink-0 max-h-32 overflow-auto border-t border-outline-variant px-4 py-3 text-sm text-error break-words"
        >
          {error}
        </div>
      )}
      {(permission || question) && (
        <div className="shrink-0 max-h-[45vh] overflow-auto" data-testid="chat-pending-requests">
          {permission && (
            <div
              data-testid="chat-permission"
              className="shrink-0 max-h-52 overflow-auto border-t border-outline-variant px-4 py-3 text-sm"
            >
              <p className="font-medium">Allow {permission.tool}?</p>
              <pre className="my-2 max-h-20 overflow-auto whitespace-pre-wrap break-words text-xs">
                {permission.command}
              </pre>
              <div className="flex gap-2">
                <button
                  type="button"
                  data-testid="chat-permission-deny"
                  disabled={responding}
                  className="min-h-11 rounded-md border border-control-border px-3"
                  onClick={() => void respondPermission("denied")}
                >
                  Deny
                </button>
                <button
                  type="button"
                  data-testid="chat-permission-allow"
                  disabled={responding}
                  className="min-h-11 rounded-md bg-primary px-3 text-primary-foreground"
                  onClick={() => void respondPermission("approved")}
                >
                  Allow once
                </button>
              </div>
            </div>
          )}
          {question && (
            <ChatQuestionForm
              key={question.requestId}
              request={question}
              busy={responding}
              onAnswer={respondQuestion}
            />
          )}
        </div>
      )}
      <div className="chat-composer-footer mx-auto w-full max-w-3xl shrink-0 px-3 pt-2 pb-3">
        <ThreadPrimitive.ScrollToBottom
          aria-label="Scroll to latest response"
          className="mx-auto mb-2 flex min-h-9 items-center gap-1 rounded-md border border-control-border bg-background px-3 text-xs text-on-surface-variant disabled:hidden"
        >
          <ArrowDown size={14} />
          Latest response
        </ThreadPrimitive.ScrollToBottom>
        <ComposerPrimitive.Root className="chat-composer-box rounded-lg border border-control-border bg-surface p-2 focus-within:ring-2 focus-within:ring-focus">
          <ComposerPrimitive.Input
            ref={input}
            data-testid="chat-input"
            aria-label="Message your agent"
            placeholder="Message your agent…"
            disabled={streaming || !ready}
            submitMode="enter"
            unstable_insertNewlineOnTouchEnter
            rows={2}
            className="chat-composer-input block max-h-[min(12rem,calc(var(--app-height,100dvh)*0.3))] w-full resize-none overflow-y-auto bg-transparent p-2 text-base sm:text-sm leading-relaxed placeholder:text-on-surface-variant focus-visible:outline-none disabled:opacity-60"
          />
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              data-testid="chat-clear-button"
              onClick={clear}
              aria-label="New conversation"
              title="New conversation"
              className={iconButton}
            >
              <Plus size={16} />
            </button>
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
      </div>
    </ThreadPrimitive.Root>
  );
}
