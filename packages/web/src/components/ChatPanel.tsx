import { MessagePrimitive, ThreadPrimitive } from "@assistant-ui/react";
import { supportsManualCompaction } from "@orc/core/coding-agents";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronsDownUp,
  History,
  LoaderCircle,
  Maximize2,
  MoreHorizontal,
  Paperclip,
  Pencil,
  RefreshCw,
  Settings2,
  Square,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "@/api/client";
import { ActionHelp } from "@/components/ActionHelp";
import { AgentMessageText } from "@/components/AgentMessageText";
import { ChatActivityList } from "@/components/ChatActivityList";
import { ChatAgentModelPicker } from "@/components/ChatAgentModelPicker";
import { ChatAttachments } from "@/components/ChatAttachments";
import {
  ChatContinueInTerminal,
  useChatContinueInTerminal,
} from "@/components/ChatContinueInTerminal";
import { ChatConversationInfo, ChatSessionPicker } from "@/components/ChatControls";
import { ChatForkNotice } from "@/components/ChatForkNotice";
import { ChatLiveAnnouncer, ChatLiveStatus } from "@/components/ChatLiveStatus";
import { ChatMessageActions } from "@/components/ChatMessageActions";
import { ChatPermissionChip } from "@/components/ChatPermissionSelect";
import {
  ChatPromptMenu,
  chatCommandOptionId,
  useChatPromptMenu,
} from "@/components/ChatPromptMenu";
import { ChatQuestionForm } from "@/components/ChatQuestionForm";
import { ChatWorkspaceControls } from "@/components/ChatWorkspaceControls";
import { MobileChatShell } from "@/components/chat-mobile/MobileChatShell";
import {
  SessionDrawer,
  SessionHomeToggles,
  SessionInspector,
  SessionTerminalCenter,
  useSessionContext,
  useSessionLiveLink,
} from "@/components/SessionHome";
import { SessionLineage } from "@/components/SessionLineage";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useChat } from "@/hooks/useChat";
import { useBreakpoint } from "@/hooks/useMediaQuery";
import { usePanelWidth } from "@/hooks/usePanelWidth";
import { usePinnedScroll } from "@/hooks/usePinnedScroll";
import { useProjects } from "@/hooks/useProjects";
import { useSessionHome } from "@/hooks/useSessionHome";
import { useCompactViewport } from "@/hooks/useVisualViewport";
import { commandSegments } from "@/lib/chat-commands";
import { pastedTextName, shouldAttachPaste } from "@/lib/composer-chips";
import { cn } from "@/lib/utils";

// The highlight layer must wrap text exactly like the textarea above it.
const composerText = "p-2 text-base leading-relaxed [scrollbar-gutter:stable]";

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
const actionButton =
  "flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-on-surface-variant hover:bg-surface hover:text-on-surface disabled:opacity-40";
const textParts = {
  Text: ({ text }: { text: string }) => <AgentMessageText>{text}</AgentMessageText>,
};
const attachmentKeys = new WeakMap<File, string>();
function attachmentKey(file: File): string {
  let key = attachmentKeys.get(file);
  if (!key) {
    key = crypto.randomUUID();
    attachmentKeys.set(file, key);
  }
  return key;
}

/** Refresh and Compact render inline in wide headers and as labeled rows in the
 *  actions menu; one component keeps every presentation identical. */
function ChatRefreshAction({
  row = false,
  large = false,
  stale,
  busy,
  disabled,
  onRefresh,
}: {
  row?: boolean;
  large?: boolean;
  stale: boolean;
  busy: boolean;
  disabled: boolean;
  onRefresh: () => void;
}) {
  const button = (
    <button
      type="button"
      data-testid="chat-refresh-button"
      onClick={onRefresh}
      disabled={disabled}
      className={cn(
        row ? actionButton : iconButton,
        large && "min-h-11 min-w-11",
        stale && "text-warning",
      )}
      data-stale={stale || undefined}
      aria-label={stale ? "Refresh session: it changed outside this chat" : "Refresh session"}
    >
      <RefreshCw size={17} className={busy ? "animate-spin" : undefined} />
      {row && "Refresh session"}
    </button>
  );
  return row ? button : <ActionHelp label="Refresh session">{button}</ActionHelp>;
}

function ChatCompactAction({
  agent,
  row = false,
  large = false,
  disabled,
  onCompact,
}: {
  agent: string;
  row?: boolean;
  large?: boolean;
  disabled: boolean;
  onCompact: () => void;
}) {
  if (!supportsManualCompaction(agent)) return null;
  const button = (
    <button
      type="button"
      data-testid="chat-compact-button"
      aria-label="Compact context"
      className={cn(row ? actionButton : iconButton, large && "min-h-11 min-w-11")}
      disabled={disabled}
      onClick={onCompact}
    >
      <ChevronsDownUp size={17} />
      {row && "Compact context"}
    </button>
  );
  return row ? button : <ActionHelp label="Compact context">{button}</ActionHelp>;
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
    streamText,
    activity,
    turn,
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
    tabs,
    newTab,
    draft,
    files,
    addFiles,
    removeFile,
    setDraft,
    queued,
    queuePaused,
    editingQueuedId,
    queuedDraft,
    setQueuedDraft,
    editQueued,
    removeQueued,
    moveQueued,
    forceQueued,
    send,
    steer,
    cancel,
    projectId,
    openThread,
  } = useChat();
  const session = useQuery({
    queryKey: ["chat-threads", "session", thread?.id],
    queryFn: () => api.chat.session(thread?.id ?? ""),
    enabled: !!thread?.runtimeId,
  });
  const answers = session.data?.queued ?? [];
  const sessionChanged = !!session.data?.changed && !streaming && !refreshing;
  const turnElsewhere = !!session.data?.running && !streaming && !refreshing;
  const forkDisabledReason =
    streaming || refreshing || reconnecting || turnElsewhere
      ? "Wait for the current response to finish before forking."
      : undefined;
  const followedSession = useRef<string | null>(null);
  useEffect(() => {
    if (!session.data?.running) followedSession.current = null;
    if (!turnElsewhere || !thread || followedSession.current === thread.id) return;
    followedSession.current = thread.id;
    void refresh().finally(() => session.refetch());
  }, [turnElsewhere, refresh, thread, session.data?.running, session.refetch]);
  const reload = async () => {
    await refresh(sessionChanged);
    void session.refetch();
  };
  const terminalControl = useChatContinueInTerminal();
  const desktop = useBreakpoint("xl");
  const phone = !useBreakpoint("md");
  const compactViewport = useCompactViewport();
  const home = useSessionHome();
  const docked = fullscreen && desktop && !home.listHidden;
  const rail = fullscreen && desktop && home.listHidden;
  const context = useSessionContext(fullscreen ? home.terminalId : null);
  const terminalCenter = fullscreen && !!home.terminalId;
  const linkError = useSessionLiveLink(home, fullscreen);
  const title = terminalCenter ? (context.terminal?.name ?? "Terminal") : thread?.title;
  const projects = useProjects();
  const owner = terminalCenter
    ? context.session?.project_id
    : (thread?.projectId ?? tabs.find((tab) => tab.key === activeKey)?.projectId);
  const projectName =
    owner === null
      ? "Unassigned"
      : (projects.data?.find((project) => project.id === owner)?.name ?? "Unknown project");
  const scroll = usePinnedScroll({
    resetKey: `${activeKey}:${thread?.id ?? ""}`,
    count: messages.length + (streaming ? 1 : 0),
    restoring: loadingHistory,
  });
  const submit = () => {
    if (!ready || (!draft.trim() && !files.length)) return;
    if (!streaming) scroll.pinToBottom();
    void send(draft);
    setDraft("");
  };
  const compactDisabled =
    !thread?.runtimeId ||
    streaming ||
    reconnecting ||
    refreshing ||
    queued.length > 0 ||
    files.length > 0;
  const header = useRef<HTMLElement>(null);
  const [headerWidth, setHeaderWidth] = useState(0);
  const headerWide = headerWidth >= 620;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  // One menu vocabulary for the phone and the narrow desktop header: Settings
  // first, then continue-in-terminal, then Refresh/Compact as labeled rows so the
  // actions stay reachable even when the phone's second header line is collapsed.
  const actionMenuRows = (includeSessionActions: boolean) => (
    <>
      <button
        type="button"
        data-testid="chat-config-button"
        aria-label="Session settings"
        className={actionButton}
        onClick={() => {
          setActionsOpen(false);
          setSettingsOpen(true);
        }}
      >
        <Settings2 size={17} />
        Session settings
      </button>
      <ChatContinueInTerminal
        control={terminalControl}
        onOpen={() => setActionsOpen(false)}
        labelled
      />
      {includeSessionActions && (
        <>
          <ChatRefreshAction
            row
            stale={sessionChanged}
            busy={refreshing || reconnecting}
            disabled={!thread || refreshing}
            onRefresh={() => {
              setActionsOpen(false);
              void reload();
            }}
          />
          <ChatCompactAction
            row
            agent={config.agent}
            disabled={compactDisabled}
            onCompact={() => {
              setActionsOpen(false);
              void send("/compact");
            }}
          />
        </>
      )}
    </>
  );
  useEffect(() => {
    if (!open || headerWide) setActionsOpen(false);
  }, [open, headerWide]);
  useLayoutEffect(() => {
    if (!open || !header.current) return;
    const observer = new ResizeObserver(([entry]) => setHeaderWidth(entry?.contentRect.width ?? 0));
    observer.observe(header.current);
    return () => observer.disconnect();
  }, [open]);
  const input = useRef<HTMLTextAreaElement>(null);
  const promptMenu = useChatPromptMenu(draft, setDraft, input, projectId);
  const activeCommandOption = promptMenu.matches[promptMenu.index];
  const inputBackdrop = useRef<HTMLDivElement>(null);
  const plainPaste = useRef(false);
  const draftSegments = useMemo(
    () => commandSegments(draft, promptMenu.commandNames),
    [draft, promptMenu.commandNames],
  );
  const highlighted = draftSegments.some((segment) => segment.command);
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
  const [queueDisclosure, setQueueDisclosure] = useState({ key: activeKey, open: false });
  useLayoutEffect(() => {
    if (open && editingQueuedId)
      setQueueDisclosure((current) =>
        current.key === activeKey && current.open ? current : { key: activeKey, open: true },
      );
    else if (!queued.length && !answers.length && !streaming)
      setQueueDisclosure((current) =>
        current.key === activeKey && current.open ? { key: activeKey, open: false } : current,
      );
  }, [activeKey, answers.length, editingQueuedId, open, queued.length, streaming]);
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
      {!(fullscreen && phone) && (
        <ChatSessionPicker
          enabled={open}
          docked={docked}
          rail={rail}
          wide={fullscreen && !desktop}
          hideTrigger={phone}
          home={fullscreen ? home : undefined}
        />
      )}
      <MobileChatShell enabled={fullscreen && phone} home={home} context={context}>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header
            ref={header}
            data-chat-gesture-header={phone ? "true" : undefined}
            className={cn(
              "chat-header shrink-0",
              // Desktop keeps every control on one line; the phone gives the title
              // its own line and moves the panel/session controls to a second line.
              phone
                ? "flex flex-col gap-0.5 px-2 py-1"
                : "flex min-h-12 items-center gap-1 px-3 py-1",
              !docked && !rail && !phone && "pl-40",
            )}
          >
            {phone ? (
              <>
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    data-testid="chat-sessions-button"
                    aria-label="Sessions, session history"
                    title="Session history"
                    className={cn(iconButton, "min-h-11 min-w-11")}
                    onClick={() => home.go({ listOpen: true })}
                  >
                    <History size={17} />
                  </button>
                  <button
                    type="button"
                    data-testid="chat-clear-button"
                    aria-label="New session"
                    title="New session"
                    disabled={tabs.some(
                      (tab) =>
                        tab.key !== activeKey &&
                        (tab.permissions.length ||
                          tab.questions.length ||
                          tab.attention ||
                          tab.error),
                    )}
                    className={cn(iconButton, "min-h-11 min-w-11")}
                    onClick={() => {
                      newTab();
                      home.go({ terminalId: null });
                    }}
                  >
                    <SquarePen size={17} />
                  </button>
                  <div className="min-w-0 flex-1">
                    <h2
                      className="truncate text-sm font-medium"
                      title={`${projectName} / ${title ?? "New session"}`}
                    >
                      {title ?? "New session"}
                    </h2>
                    <p className="truncate text-xs text-muted-foreground">
                      <span data-testid="session-project-breadcrumb">{projectName}</span>
                      {" · "}
                      {thread?.host ?? "local"}
                    </p>
                  </div>
                  {streaming && (
                    <LoaderCircle
                      size={14}
                      aria-hidden="true"
                      className="chat-compact-activity shrink-0 text-progress"
                    />
                  )}
                  <Popover open={actionsOpen} onOpenChange={setActionsOpen}>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        aria-label="Session actions"
                        data-testid="chat-options-button"
                        className={cn(
                          iconButton,
                          "min-h-11 min-w-11",
                          sessionChanged && "text-warning",
                        )}
                      >
                        <MoreHorizontal size={17} />
                      </button>
                    </PopoverTrigger>
                    {/* Anchor below the whole two-line header so the menu never
                        covers the Terminal/Inspector/Refresh/Compact controls. */}
                    <PopoverAnchor virtualRef={header} />
                    <PopoverContent
                      data-testid="chat-actions-menu"
                      aria-label="Session actions"
                      align="end"
                      className="flex w-56 flex-col gap-1 p-1"
                    >
                      {actionMenuRows(compactViewport)}
                    </PopoverContent>
                  </Popover>
                </div>
                <div className="chat-header-controls flex items-center justify-end gap-0.5">
                  <SessionHomeToggles home={home} gestures />
                  {!terminalCenter && (
                    <div
                      data-testid="chat-header-actions"
                      className="flex shrink-0 items-center gap-0.5"
                    >
                      <ChatRefreshAction
                        large
                        stale={sessionChanged}
                        busy={refreshing || reconnecting}
                        disabled={!thread || refreshing}
                        onRefresh={() => void reload()}
                      />
                      <ChatCompactAction
                        large
                        agent={config.agent}
                        disabled={compactDisabled}
                        onCompact={() => void send("/compact")}
                      />
                    </div>
                  )}
                </div>
              </>
            ) : title || fullscreen ? (
              <h2
                className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium"
                title={fullscreen ? `${projectName} / ${title ?? "New session"}` : title}
              >
                {fullscreen && (
                  <>
                    <span
                      data-testid="session-project-breadcrumb"
                      className="max-w-[40%] truncate text-muted-foreground"
                    >
                      {projectName}
                    </span>
                    <span aria-hidden="true" className="text-muted-foreground">
                      /
                    </span>
                  </>
                )}
                <span className="min-w-0 truncate">{title ?? "New session"}</span>
              </h2>
            ) : (
              <div className="min-w-0 flex-1" aria-hidden="true" />
            )}
            {!phone && streaming && (
              <LoaderCircle
                size={14}
                aria-hidden="true"
                className="chat-compact-activity shrink-0 text-progress"
              />
            )}
            {!phone &&
              (terminalCenter ? null : headerWide ? (
                <div data-testid="chat-header-actions" className="flex shrink-0 items-center gap-1">
                  <ChatRefreshAction
                    stale={sessionChanged}
                    busy={refreshing || reconnecting}
                    disabled={!thread || refreshing}
                    onRefresh={() => void reload()}
                  />
                  <ChatContinueInTerminal control={terminalControl} />
                  <ChatCompactAction
                    agent={config.agent}
                    disabled={compactDisabled}
                    onCompact={() => void send("/compact")}
                  />
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
                <Popover open={actionsOpen} onOpenChange={setActionsOpen}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      aria-label="Session actions"
                      data-testid="chat-options-button"
                      className={cn(iconButton, sessionChanged && "text-warning")}
                    >
                      <MoreHorizontal size={17} />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    data-testid="chat-actions-menu"
                    aria-label="Session actions"
                    align="end"
                    className="flex w-52 flex-col gap-1 p-1"
                  >
                    {actionMenuRows(true)}
                  </PopoverContent>
                </Popover>
              ))}
            {fullscreen && !phone && <SessionHomeToggles home={home} />}
            {onToggleFullscreen && (
              <ActionHelp label="Full screen chat">
                <button
                  type="button"
                  data-testid="chat-fullscreen-button"
                  onClick={onToggleFullscreen}
                  className={cn(iconButton, "hidden xl:inline-flex")}
                  aria-label="Full screen chat"
                >
                  <Maximize2 size={17} />
                </button>
              </ActionHelp>
            )}
            {/* The phone chat is a regular page: navigation (Back, the drawer or
                another destination) leaves it, so it has no close button. */}
            {!(fullscreen && phone) && (
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
            )}
          </header>
          {linkError && (
            <p role="alert" className="px-4 py-1 text-xs text-error">
              {linkError}
            </p>
          )}
          {terminalCenter && <SessionTerminalCenter context={context} />}
          <div className={cn("flex min-h-0 flex-1 flex-col", terminalCenter && "hidden")}>
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
            <div className="relative flex min-h-0 flex-1 flex-col">
              <ThreadPrimitive.Viewport
                ref={scroll.viewportRef}
                autoScroll={false}
                scrollToBottomOnRunStart={false}
                scrollToBottomOnInitialize={false}
                scrollToBottomOnThreadSwitch={false}
                data-testid="chat-messages"
                data-pinned={scroll.pinned}
                className="chat-messages relative flex-1 min-h-0 overflow-y-auto px-4 py-5 sm:px-6"
              >
                <div ref={scroll.contentRef} className="flex min-h-full flex-col">
                  {historyBefore !== null && (
                    <button
                      type="button"
                      data-testid="chat-load-older"
                      disabled={loadingHistory || streaming}
                      className="mx-auto mb-4 block min-h-8 rounded-md border border-border px-3 text-sm text-primary hover:bg-surface disabled:opacity-50"
                      onClick={() => {
                        scroll.keepPosition();
                        void loadOlder();
                      }}
                    >
                      {loadingHistory ? "Loading older messages…" : "Load older messages"}
                    </button>
                  )}
                  {messages.length === 0 && !streaming && (
                    <div className="chat-empty-state mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-2">
                      <h3 className="text-lg font-medium">What are you working on?</h3>
                      <p className="max-w-xs text-sm leading-relaxed text-on-surface-variant">
                        Ask about your tasks, review agent activity, or work through a coding
                        question.
                      </p>
                    </div>
                  )}
                  <ChatForkNotice thread={thread ?? undefined} />
                  <SessionLineage sessionId={thread?.id ?? null} />
                  <ThreadPrimitive.Messages>
                    {({ message }) => {
                      const custom = message.metadata.custom;
                      const live = custom.live === true;
                      const content = typeof custom.content === "string" ? custom.content : "";
                      return (
                        <MessagePrimitive.Root
                          style={{ contentVisibility: "auto", containIntrinsicSize: "auto 120px" }}
                          data-testid="chat-message"
                          data-role={message.role}
                          className="group/message mx-auto mb-3 w-full max-w-3xl min-w-0 text-base leading-[1.6]"
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
                                  : "mb-1 text-xs font-medium text-on-surface-variant"
                              }
                            >
                              {message.role === "user"
                                ? "You"
                                : typeof custom.agent === "string"
                                  ? custom.agent
                                  : "Assistant"}
                            </div>
                            <div
                              data-testid="chat-message-content"
                              className="min-w-0 wrap-break-word"
                            >
                              <ChatActivityList
                                value={custom.activity}
                                turn={custom.turn}
                                live={live}
                              />
                              <ChatAttachments value={custom.attachments} />
                              <MessagePrimitive.Parts components={textParts} />
                            </div>
                          </div>
                          {!live && (
                            <ChatMessageActions
                              threadId={thread?.id}
                              messageId={message.id}
                              role={message.role === "user" ? "user" : "assistant"}
                              content={content}
                              turn={custom.turn}
                              forkDisabledReason={forkDisabledReason}
                              onForked={openThread}
                            />
                          )}
                        </MessagePrimitive.Root>
                      );
                    }}
                  </ThreadPrimitive.Messages>
                </div>
              </ThreadPrimitive.Viewport>
              {!scroll.pinned && messages.length > 0 && (
                <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center px-4">
                  <button
                    type="button"
                    data-testid="chat-jump-latest"
                    aria-label={
                      scroll.newCount ? `Jump to latest, ${scroll.newCount} new` : "Jump to latest"
                    }
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={scroll.pinToBottom}
                    className="pointer-events-auto flex min-h-8 items-center gap-1.5 rounded-md border border-control-border bg-background px-3 text-xs text-on-surface shadow-sm hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-sm:min-h-11"
                  >
                    <ArrowDown aria-hidden="true" size={14} />
                    Jump to latest
                    {scroll.newCount > 0 && (
                      <span className="text-on-surface-variant">· {scroll.newCount} new</span>
                    )}
                  </button>
                </div>
              )}
            </div>
            {streaming && (
              <ChatLiveStatus
                agent={streamingAgent}
                startedAt={turn?.startedAt}
                activity={activity}
              />
            )}
            <ChatLiveAnnouncer
              streaming={streaming}
              agent={streamingAgent}
              text={streamText}
              last={messages[messages.length - 1]}
            />
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
              <div
                className="shrink-0 max-h-[45vh] overflow-auto"
                data-testid="chat-pending-requests"
              >
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
                        className="min-h-8 rounded-md border border-control-border px-3 max-md:min-h-11 pointer-coarse:min-h-11"
                        onClick={() => void respondPermission("denied")}
                      >
                        Deny
                      </button>
                      <button
                        type="button"
                        data-testid="chat-permission-allow"
                        disabled={responding}
                        className="min-h-8 rounded-md bg-primary px-3 text-primary-foreground max-md:min-h-11 pointer-coarse:min-h-11"
                        onClick={() => void respondPermission("approved")}
                      >
                        Allow once
                      </button>
                      {["claude", "codex", "pi"].includes(config.agent) && (
                        <button
                          type="button"
                          data-testid="chat-permission-allow-all"
                          disabled={responding}
                          title="Switch this session to full access / bypass permissions"
                          className="min-h-8 rounded-md border border-control-border px-3 max-md:min-h-11 pointer-coarse:min-h-11"
                          onClick={() =>
                            void changePermissions({
                              ...config,
                              permissionMode: "bypassPermissions",
                            })
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
            {queued.length + answers.length > 0 && (
              <details
                key={activeKey}
                open={queueDisclosure.key === activeKey && queueDisclosure.open}
                onToggle={(event) =>
                  setQueueDisclosure({ key: activeKey, open: event.currentTarget.open })
                }
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
                    {queued.length + answers.length} pending{queuePaused ? " · Paused" : ""}
                  </span>
                </summary>
                <ol className="max-h-[min(30vh,14rem)] overflow-y-auto pb-1">
                  {answers.map((answer) => (
                    <li
                      key={answer.id}
                      data-testid="chat-queued-answer"
                      className="flex min-h-11 items-center gap-2 border-t border-outline-variant text-sm sm:min-h-9"
                    >
                      <span className="shrink-0 text-xs text-on-surface-variant">ORC answer</span>
                      <span className="min-w-0 truncate">{answer.title}</span>
                    </li>
                  ))}
                  {queued.map((entry, index) => (
                    <QueuedMessage
                      key={entry.id}
                      content={entry.content}
                      editing={editingQueuedId === entry.id}
                      draft={queuedDraft}
                      onDraftChange={setQueuedDraft}
                      canMoveUp={index > 0}
                      canMoveDown={index < queued.length - 1}
                      forceDisabled={refreshing || !!editingQueuedId}
                      onEdit={() => editQueued(entry.id)}
                      onMoveUp={() => moveQueued(entry.id, -1)}
                      onMoveDown={() => moveQueued(entry.id, 1)}
                      onSave={(content) => editQueued(entry.id, content)}
                      onCancel={() => editQueued(null)}
                      onForce={() => forceQueued(entry.id)}
                      onRemove={() => removeQueued(entry.id)}
                    />
                  ))}
                </ol>
              </details>
            )}
            <div className="chat-composer-footer relative w-full shrink-0 px-4 pt-2 pb-3 sm:px-6">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (event.target !== event.currentTarget) return;
                  submit();
                }}
                data-testid="chat-composer-box"
                onDragOver={(event) => {
                  if (event.dataTransfer.types.includes("Files")) event.preventDefault();
                }}
                onDrop={(event) => {
                  if (event.dataTransfer.files.length) {
                    event.preventDefault();
                    addFiles(Array.from(event.dataTransfer.files));
                  }
                }}
                className="chat-composer-box mx-auto w-full max-w-3xl rounded-2xl border border-border bg-surface p-2 focus-within:ring-2 focus-within:ring-focus"
              >
                {files.length > 0 && (
                  <ul data-testid="chat-attachments" className="flex flex-wrap gap-1 px-2 pb-1">
                    {files.map((file, index) => (
                      <li
                        key={attachmentKey(file)}
                        className="flex min-w-0 max-w-full items-center gap-1 rounded border border-border px-2 text-xs"
                      >
                        <span className="truncate">{file.name}</span>
                        <button
                          type="button"
                          data-testid="chat-remove-attachment"
                          aria-label={`Remove ${file.name}`}
                          className={`${iconButton} max-sm:min-h-11 max-sm:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11`}
                          onClick={() => removeFile(index)}
                        >
                          <X size={13} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <ChatPromptMenu {...promptMenu} />
                <div className="relative">
                  {highlighted && (
                    <div
                      ref={inputBackdrop}
                      aria-hidden
                      data-testid="chat-input-highlight"
                      className={`${composerText} pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words`}
                    >
                      {draftSegments.map((segment, index) =>
                        segment.command ? (
                          <span
                            // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
                            key={index}
                            data-testid="chat-input-command"
                            className="rounded-sm bg-surface-highest text-on-surface shadow-[0_0_0_2px_var(--color-surface-highest)] [-webkit-text-stroke:0.5px_currentColor]"
                          >
                            {segment.text}
                          </span>
                        ) : (
                          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
                          <span key={index}>{segment.text}</span>
                        ),
                      )}
                      {"​"}
                    </div>
                  )}
                  <textarea
                    ref={input}
                    data-testid="chat-input"
                    aria-label="Message your agent"
                    aria-controls={promptMenu.matches.length ? "chat-prompt-menu" : undefined}
                    aria-activedescendant={
                      activeCommandOption ? chatCommandOptionId(activeCommandOption) : undefined
                    }
                    placeholder="Ask anything. / for prompts and skills"
                    disabled={!ready}
                    value={draft}
                    onChange={(event) => {
                      setDraft(event.target.value);
                      promptMenu.syncCaret();
                    }}
                    onSelect={promptMenu.syncCaret}
                    onScroll={(event) => {
                      if (inputBackdrop.current)
                        inputBackdrop.current.scrollTop = event.currentTarget.scrollTop;
                    }}
                    onPaste={(event) => {
                      const plain = plainPaste.current;
                      plainPaste.current = false;
                      if (event.clipboardData.files.length) {
                        event.preventDefault();
                        addFiles(Array.from(event.clipboardData.files));
                        return;
                      }
                      const text = event.clipboardData.getData("text/plain");
                      if (plain || !shouldAttachPaste(text)) return;
                      event.preventDefault();
                      const name = pastedTextName(files.map((file) => file.name));
                      addFiles([new File([text], name, { type: "text/plain" })]);
                    }}
                    onKeyDown={(event) => {
                      plainPaste.current =
                        (event.ctrlKey || event.metaKey) &&
                        event.shiftKey &&
                        event.key.toLowerCase() === "v";
                      if (promptMenu.onKeyDown(event)) return;
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
                    className={`chat-composer-input ${composerText} relative block w-full resize-none overflow-y-auto bg-transparent placeholder:text-on-surface-variant focus-visible:outline-hidden disabled:opacity-60 ${highlighted ? "text-transparent caret-on-surface" : ""}`}
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <div
                    data-testid="chat-composer-tools"
                    className="chat-composer-tools flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-0.5"
                  >
                    <label
                      className={`${iconButton} max-sm:min-h-11 max-sm:min-w-11 focus-within:ring-2 focus-within:ring-focus`}
                      aria-label="Attach files"
                      data-testid="chat-attach-button"
                      title="Attach files (up to 20 MB total)"
                    >
                      <Paperclip size={16} />
                      <input
                        type="file"
                        multiple
                        data-testid="chat-file-input"
                        aria-label="Attach files"
                        disabled={!ready}
                        className="sr-only"
                        onChange={(event) => {
                          addFiles(Array.from(event.target.files ?? []));
                          event.target.value = "";
                        }}
                      />
                    </label>
                    <ChatAgentModelPicker key={thread?.id ?? "new"} />
                    <ChatWorkspaceControls />
                    <ChatPermissionChip />
                  </div>
                  <div className="flex items-center gap-1">
                    {streaming && thread?.capabilities?.steering && (
                      <ActionHelp
                        label="Send now"
                        description="Send this message into the active response; ordinary Send queues it for later"
                      >
                        <button
                          type="button"
                          data-testid="chat-steer-button"
                          onClick={() => void steer()}
                          disabled={!draft.trim() || !!files.length || responding}
                          aria-label="Send now"
                          className={iconButton}
                        >
                          <ArrowUp size={17} className="rotate-45" />
                        </button>
                      </ActionHelp>
                    )}
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
                        disabled={!ready || (!draft.trim() && !files.length)}
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
          {fullscreen && home.drawer && !phone && <SessionDrawer context={context} />}
        </div>
      </MobileChatShell>
      {fullscreen && !phone && <SessionInspector context={context} home={home} narrow={!desktop} />}
    </ThreadPrimitive.Root>
  );
}

function QueuedMessage({
  content,
  editing,
  draft,
  onDraftChange,
  canMoveUp,
  canMoveDown,
  forceDisabled,
  onEdit,
  onMoveUp,
  onMoveDown,
  onSave,
  onCancel,
  onForce,
  onRemove,
}: {
  content: string;
  editing: boolean;
  draft: string;
  onDraftChange: (draft: string) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  forceDisabled: boolean;
  onEdit: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
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
        className="flex size-11 shrink-0 items-center justify-center rounded text-on-surface-variant hover:bg-surface hover:text-destructive focus-visible:ring-2 focus-visible:ring-focus sm:size-8"
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
          <ActionHelp label="Move pending message up">
            <button
              type="button"
              data-testid="chat-queued-up"
              disabled={!canMoveUp}
              aria-label="Move pending message up"
              onClick={onMoveUp}
              className="flex size-11 shrink-0 items-center justify-center rounded text-on-surface-variant hover:bg-surface hover:text-on-surface focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-40 sm:size-8"
            >
              <ArrowUp size={14} />
            </button>
          </ActionHelp>
          <ActionHelp label="Move pending message down">
            <button
              type="button"
              data-testid="chat-queued-down"
              disabled={!canMoveDown}
              aria-label="Move pending message down"
              onClick={onMoveDown}
              className="flex size-11 shrink-0 items-center justify-center rounded text-on-surface-variant hover:bg-surface hover:text-on-surface focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-40 sm:size-8"
            >
              <ArrowDown size={14} />
            </button>
          </ActionHelp>
          <ActionHelp label="Edit pending message">
            <button
              type="button"
              data-testid="chat-queued-edit"
              onClick={onEdit}
              aria-label="Edit pending message"
              className="flex size-11 shrink-0 items-center justify-center rounded text-on-surface-variant hover:bg-surface hover:text-on-surface focus-visible:ring-2 focus-visible:ring-focus sm:size-8"
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
              className="flex size-11 shrink-0 items-center justify-center rounded text-on-surface-variant hover:bg-surface hover:text-on-surface focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-40 sm:size-8"
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
