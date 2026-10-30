import { MessagePrimitive, ThreadPrimitive } from "@assistant-ui/react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  LoaderCircle,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Settings2,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActionHelp } from "@/components/ActionHelp";
import { AgentMessageText } from "@/components/AgentMessageText";
import { ChatActivityList } from "@/components/ChatActivityList";
import {
  ChatContinueInTerminal,
  useChatContinueInTerminal,
} from "@/components/ChatContinueInTerminal";
import {
  ChatAgentPicker,
  ChatConversationInfo,
  ChatModelPicker,
  ChatSessionPicker,
} from "@/components/ChatControls";
import { ChatQuestionForm } from "@/components/ChatQuestionForm";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useChat } from "@/hooks/useChat";
import { useBreakpoint } from "@/hooks/useMediaQuery";
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
  "inline-flex min-h-8 min-w-8 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface hover:text-on-surface disabled:opacity-40";
const textParts = {
  Text: ({ text }: { text: string }) => <AgentMessageText>{text}</AgentMessageText>,
};
function keepConversationDialog(event: Event) {
  if (event.target instanceof Element && event.target.closest('[role="dialog"]'))
    event.preventDefault();
}

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
    reconnecting,
    refreshing,
    refresh,
    streamingAgent,
    error,
    config,
    ready,
    thread,
    historyBefore,
    loadingHistory,
    loadOlder,
    permission,
    respondPermission,
    changePermissions,
    question,
    respondQuestion,
    responding,
    activeKey,
    draft,
    setDraft,
    queued,
    queuePaused,
    editingQueuedId,
    queuedDraft,
    setQueuedDraft,
    editQueued,
    removeQueued,
    forceQueued,
    send,
    cancel,
  } = useChat();
  const terminalControl = useChatContinueInTerminal();
  const desktop = useBreakpoint("xl");
  const [historyVisible, setHistoryVisible] = useState(true);
  const docked = fullscreen && desktop && historyVisible;
  const submit = () => {
    if (!ready || !draft.trim()) return;
    void send(draft);
    setDraft("");
  };
  const header = useRef<HTMLElement>(null);
  const [headerWide, setHeaderWide] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useLayoutEffect(() => {
    if (!open || !header.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setHeaderWide((entry?.contentRect.width ?? 0) >= 620),
    );
    observer.observe(header.current);
    return () => observer.disconnect();
  }, [open]);
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      if (!input.current) return;
      input.current.style.height = "auto";
      input.current.style.height = draft
        ? `${Math.min(input.current.scrollHeight, 160)}px`
        : "40px";
    };
    measure();
    let width = 0;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || width === entry.contentRect.width) return;
      width = entry.contentRect.width;
      measure();
    });
    if (input.current) observer.observe(input.current);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [draft, open]);
  const queueDetails = useRef<HTMLDetailsElement>(null);
  useLayoutEffect(() => {
    if (open && editingQueuedId && queueDetails.current) queueDetails.current.open = true;
  }, [editingQueuedId, open]);
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
    if (open && !embedded && !window.matchMedia("(pointer: coarse)").matches)
      input.current?.focus();
  }, [open, embedded]);
  if (!open) return <div data-testid="chat-panel-collapsed" className="hidden" />;
  return (
    <ThreadPrimitive.Root
      data-testid="chat-panel"
      data-streaming={streaming ? "true" : "false"}
      style={embedded ? undefined : { width: panel.width, maxWidth: "50vw" }}
      className={cn(
        "relative h-full flex min-h-0 bg-background",
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
      <ChatSessionPicker
        docked={docked}
        onCollapse={() => setHistoryVisible(false)}
        onExpand={fullscreen && desktop ? () => setHistoryVisible(true) : undefined}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header
          ref={header}
          className={cn(
            "chat-header flex min-h-12 shrink-0 items-center gap-1 px-3 py-1",
            !docked && "pl-40",
          )}
        >
          <h2
            className="min-w-0 flex-1 truncate text-sm font-medium"
            title={thread?.title || "Sessions"}
          >
            {thread?.title || "Sessions"}
          </h2>
          {headerWide ? (
            <div data-testid="chat-header-actions" className="flex shrink-0 items-center gap-1">
              <ActionHelp label="Refresh session">
                <button
                  type="button"
                  data-testid="chat-refresh-button"
                  onClick={() => void refresh()}
                  disabled={!thread || refreshing}
                  className={iconButton}
                  aria-label="Refresh session"
                >
                  <RefreshCw
                    size={17}
                    className={refreshing || reconnecting ? "animate-spin" : undefined}
                  />
                </button>
              </ActionHelp>
              <ChatContinueInTerminal control={terminalControl} />
              <ActionHelp label="Session settings">
                <button
                  type="button"
                  data-testid="chat-config-button"
                  aria-label="Session settings"
                  className={iconButton}
                  onClick={() => setSettingsOpen(true)}
                >
                  <Settings2 size={17} />
                </button>
              </ActionHelp>
            </div>
          ) : (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label="Session actions"
                  data-testid="chat-options-button"
                  className={iconButton}
                >
                  <MoreHorizontal size={17} />
                </button>
              </PopoverTrigger>
              <PopoverContent
                aria-label="Session actions"
                align="end"
                className="flex w-auto items-center gap-1"
                onInteractOutside={keepConversationDialog}
                onFocusOutside={keepConversationDialog}
              >
                <ActionHelp label="Refresh session">
                  <button
                    type="button"
                    data-testid="chat-refresh-button"
                    onClick={() => void refresh()}
                    disabled={!thread || refreshing}
                    className={iconButton}
                    aria-label="Refresh session"
                  >
                    <RefreshCw
                      size={17}
                      className={refreshing || reconnecting ? "animate-spin" : undefined}
                    />
                  </button>
                </ActionHelp>
                <ChatContinueInTerminal control={terminalControl} />
                <ActionHelp label="Session settings">
                  <button
                    type="button"
                    data-testid="chat-config-button"
                    aria-label="Session settings"
                    className={iconButton}
                    onClick={() => setSettingsOpen(true)}
                  >
                    <Settings2 size={17} />
                  </button>
                </ActionHelp>
              </PopoverContent>
            </Popover>
          )}
          {onToggleFullscreen && (
            <ActionHelp label={fullscreen ? "Exit full screen chat" : "Full screen chat"}>
              <button
                type="button"
                data-testid="chat-fullscreen-button"
                onClick={onToggleFullscreen}
                className={cn(iconButton, "hidden xl:inline-flex")}
                aria-label={fullscreen ? "Exit full screen chat" : "Full screen chat"}
              >
                {fullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
              </button>
            </ActionHelp>
          )}
          <ActionHelp label="Close chat">
            <button
              type="button"
              onClick={onClose ?? onToggle}
              data-testid="chat-close-button"
              className={iconButton}
              aria-label="Close chat"
            >
              <X size={18} />
            </button>
          </ActionHelp>
        </header>
        <ChatConversationInfo open={settingsOpen} onOpenChange={setSettingsOpen} />
        {reconnecting && (
          <p
            role="status"
            data-testid="chat-reconnecting"
            className="px-4 py-1 text-xs text-muted-foreground"
          >
            Connection interrupted. Reconnecting…
          </p>
        )}
        <ThreadPrimitive.Viewport
          ref={viewport}
          data-testid="chat-messages"
          className="relative flex-1 min-h-0 overflow-y-auto px-4 py-5 sm:px-6"
        >
          {historyBefore !== null && (
            <button
              type="button"
              data-testid="chat-load-older"
              disabled={loadingHistory || streaming}
              className="mx-auto mb-4 block min-h-8 rounded-md border border-border px-3 text-sm text-primary hover:bg-surface disabled:opacity-50"
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
                className="mx-auto mb-6 w-full max-w-3xl min-w-0 text-base leading-[1.65]"
              >
                <div
                  className={
                    message.role === "user"
                      ? "ml-auto w-fit max-w-[90%] rounded-2xl bg-surface px-4 py-2"
                      : undefined
                  }
                >
                  <div
                    data-testid="chat-message-agent"
                    className={
                      message.role === "user"
                        ? "sr-only"
                        : "mb-2 text-xs font-medium text-on-surface-variant"
                    }
                  >
                    {message.role === "user"
                      ? "You"
                      : typeof message.metadata.custom.agent === "string"
                        ? message.metadata.custom.agent
                        : "Assistant"}
                  </div>
                  <div data-testid="chat-message-content" className="min-w-0 wrap-break-word">
                    <ChatActivityList value={message.metadata.custom.activity} />
                    <MessagePrimitive.Parts components={textParts} />
                  </div>
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
            className="shrink-0 max-h-32 overflow-auto border-t border-outline-variant px-4 py-3 text-sm text-error wrap-break-word"
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
                <pre className="my-2 max-h-20 overflow-auto whitespace-pre-wrap wrap-break-word text-xs">
                  {permission.command}
                </pre>
                <div className="flex gap-2">
                  <button
                    type="button"
                    data-testid="chat-permission-deny"
                    disabled={responding}
                    className="min-h-8 rounded-md border border-control-border px-3"
                    onClick={() => void respondPermission("denied")}
                  >
                    Deny
                  </button>
                  <button
                    type="button"
                    data-testid="chat-permission-allow"
                    disabled={responding}
                    className="min-h-8 rounded-md bg-primary px-3 text-primary-foreground"
                    onClick={() => void respondPermission("approved")}
                  >
                    Allow once
                  </button>
                  {["claude", "codex"].includes(config.agent) && (
                    <button
                      type="button"
                      data-testid="chat-permission-allow-all"
                      disabled={responding}
                      title="Switch this session to full access / bypass permissions"
                      className="min-h-8 rounded-md border border-control-border px-3"
                      onClick={() =>
                        void changePermissions({ ...config, permissionMode: "bypassPermissions" })
                      }
                    >
                      Allow all
                    </button>
                  )}
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
        {queued.length > 0 && (
          <details
            key={activeKey}
            ref={queueDetails}
            data-testid="chat-message-queue"
            aria-label="Pending messages"
            className="group mx-auto w-full max-w-[calc(48rem+3rem)] shrink-0 border-t border-outline-variant px-4 sm:px-6"
          >
            <summary
              data-testid="chat-queue-toggle"
              className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-xs text-on-surface-variant hover:text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus sm:min-h-8 [&::-webkit-details-marker]:hidden"
            >
              <ChevronDown
                size={14}
                className="shrink-0 transition-transform group-open:rotate-180"
              />
              <span role="status" data-testid="chat-pending-count">
                {queued.length} pending{queuePaused ? " · Paused" : ""}
              </span>
            </summary>
            <ol className="max-h-[min(30vh,14rem)] overflow-y-auto pb-1">
              {queued.map((entry) => (
                <QueuedMessage
                  key={entry.id}
                  content={entry.content}
                  editing={editingQueuedId === entry.id}
                  draft={queuedDraft}
                  onDraftChange={setQueuedDraft}
                  forceDisabled={refreshing || !!editingQueuedId}
                  onEdit={() => editQueued(entry.id)}
                  onSave={(content) => editQueued(entry.id, content)}
                  onCancel={() => editQueued(null)}
                  onForce={() => forceQueued(entry.id)}
                  onRemove={() => removeQueued(entry.id)}
                />
              ))}
            </ol>
          </details>
        )}
        <div className="chat-composer-footer w-full shrink-0 px-4 pt-2 pb-3 sm:px-6">
          <ThreadPrimitive.ScrollToBottom
            aria-label="Scroll to latest response"
            className="mx-auto mb-2 flex min-h-9 items-center gap-1 rounded-md border border-control-border bg-background px-3 text-xs text-on-surface-variant disabled:hidden"
          >
            <ArrowDown size={14} />
            Latest response
          </ThreadPrimitive.ScrollToBottom>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (event.target !== event.currentTarget) return;
              submit();
            }}
            data-testid="chat-composer-box"
            className="chat-composer-box mx-auto w-full max-w-3xl rounded-2xl border border-border bg-surface p-2 focus-within:ring-2 focus-within:ring-focus"
          >
            <textarea
              ref={input}
              data-testid="chat-input"
              aria-label="Message your agent"
              placeholder="Message your agent…"
              disabled={!ready}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  !window.matchMedia("(pointer: coarse)").matches
                ) {
                  event.preventDefault();
                  submit();
                }
              }}
              rows={1}
              className="chat-composer-input block max-h-[min(12rem,calc(var(--app-height,100dvh)*0.3))] w-full resize-none overflow-y-auto bg-transparent p-2 text-base leading-relaxed placeholder:text-on-surface-variant focus-visible:outline-hidden disabled:opacity-60"
            />
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 flex-1 items-start gap-0">
                <ChatAgentPicker />
                <ChatModelPicker key={`${thread?.id ?? "new"}:${config.agent}`} />
              </div>
              <div className="flex items-center gap-1">
                {streaming && (
                  <ActionHelp label="Stop response">
                    <button
                      type="button"
                      data-testid="chat-cancel-button"
                      aria-label="Stop response"
                      onClick={cancel}
                      className={iconButton}
                    >
                      <Square size={17} />
                    </button>
                  </ActionHelp>
                )}
                <ActionHelp label={streaming ? "Queue message" : "Send message"}>
                  <button
                    type="submit"
                    disabled={!ready || !draft.trim()}
                    data-testid="chat-send-button"
                    aria-label={streaming ? "Queue message" : "Send message"}
                    className="chat-send-button inline-flex min-h-8 min-w-8 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-40"
                  >
                    <ArrowUp size={18} />
                  </button>
                </ActionHelp>
              </div>
            </div>
          </form>
        </div>
      </div>
    </ThreadPrimitive.Root>
  );
}

function QueuedMessage({
  content,
  editing,
  draft,
  onDraftChange,
  forceDisabled,
  onEdit,
  onSave,
  onCancel,
  onForce,
  onRemove,
}: {
  content: string;
  editing: boolean;
  draft: string;
  onDraftChange: (draft: string) => void;
  forceDisabled: boolean;
  onEdit: () => void;
  onSave: (content: string) => void;
  onCancel: () => void;
  onForce: () => void;
  onRemove: () => void;
}) {
  const removeButton = (
    <ActionHelp label="Remove pending message">
      <button
        type="button"
        data-testid="chat-queued-remove"
        aria-label="Remove pending message"
        onClick={onRemove}
        className="flex size-8 shrink-0 items-center justify-center rounded text-on-surface-variant hover:bg-surface hover:text-destructive focus-visible:ring-2 focus-visible:ring-focus sm:size-8"
      >
        <Trash2 size={14} />
      </button>
    </ActionHelp>
  );
  return (
    <li data-testid="chat-queued-message" className="border-t border-outline-variant text-sm">
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim()) onSave(draft);
          }}
        >
          <textarea
            data-testid="chat-queued-input"
            aria-label="Edit pending message"
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            rows={2}
            className="mt-2 block max-h-32 w-full rounded border border-control-border bg-background p-2 text-base sm:text-sm"
          />
          <div className="flex items-center">
            <button
              type="submit"
              data-testid="chat-queued-save"
              disabled={!draft.trim()}
              className="min-h-8 px-2 text-xs disabled:opacity-40 sm:min-h-8"
            >
              Save
            </button>
            <button
              type="button"
              data-testid="chat-queued-edit-cancel"
              onClick={onCancel}
              className="min-h-8 px-2 text-xs text-on-surface-variant sm:min-h-8"
            >
              Cancel
            </button>
            <div className="ml-auto">{removeButton}</div>
          </div>
        </form>
      ) : (
        <div className="flex min-h-11 items-center gap-1 sm:min-h-9">
          <p
            data-testid="chat-queued-content"
            title={content}
            className="min-w-0 flex-1 truncate text-xs"
          >
            {content}
          </p>
          <ActionHelp label="Edit pending message">
            <button
              type="button"
              data-testid="chat-queued-edit"
              onClick={onEdit}
              aria-label="Edit pending message"
              className="flex size-8 shrink-0 items-center justify-center rounded text-on-surface-variant hover:bg-surface hover:text-on-surface focus-visible:ring-2 focus-visible:ring-focus sm:size-8"
            >
              <Pencil size={14} />
            </button>
          </ActionHelp>
          <ActionHelp
            label="Force send pending message"
            description="Stop the current response and send this message next"
          >
            <button
              type="button"
              data-testid="chat-queued-force"
              disabled={forceDisabled}
              aria-label="Force send pending message"
              onClick={onForce}
              className="flex size-8 shrink-0 items-center justify-center rounded text-on-surface-variant hover:bg-surface hover:text-on-surface focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-40 sm:size-8"
            >
              <ArrowUp size={14} />
            </button>
          </ActionHelp>
          {removeButton}
        </div>
      )}
    </li>
  );
}
