import { MessagePrimitive, ThreadPrimitive } from "@assistant-ui/react";
import { supportsManualCompaction } from "@orc/core/coding-agents";
import { projectForFolder } from "@orc/core/project-path";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronsDownUp,
  LoaderCircle,
  Maximize2,
  MessageSquare,
  Minimize2,
  MoreHorizontal,
  Paperclip,
  Pencil,
  RefreshCw,
  Settings2,
  Square,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "@/api/client";
import { ActionHelp } from "@/components/ActionHelp";
import { AgentMessageText } from "@/components/AgentMessageText";
import { AgentNotificationBell } from "@/components/AgentNotifications";
import { ChatActivityList } from "@/components/ChatActivityList";
import { ChatAgentModelPicker } from "@/components/ChatAgentModelPicker";
import { ChatAttachments } from "@/components/ChatAttachments";
import {
  ChatContinueInTerminal,
  useChatContinueInTerminal,
} from "@/components/ChatContinueInTerminal";
import { ChatConversationInfo, ChatSessionPicker } from "@/components/ChatControls";
import { ChatLiveAnnouncer, ChatLiveStatus } from "@/components/ChatLiveStatus";
import { ChatPermissionChip } from "@/components/ChatPermissionSelect";
import {
  ChatPromptMenu,
  chatCommandOptionId,
  useChatPromptMenu,
} from "@/components/ChatPromptMenu";
import { ChatQuestionForm } from "@/components/ChatQuestionForm";
import { ChatWorkspaceControls } from "@/components/ChatWorkspaceControls";
import { LiveSessionDetail } from "@/components/LiveSessionDetail";
import {
  SessionDrawer,
  SessionHomeToggles,
  SessionInspector,
  SessionTerminalCenter,
  useSessionContext,
  useSessionLiveLink,
} from "@/components/SessionHome";
import { ContinueInChat } from "@/components/terminals/ContinueInChat";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useChat } from "@/hooks/useChat";
import { useBreakpoint } from "@/hooks/useMediaQuery";
import { usePanelWidth } from "@/hooks/usePanelWidth";
import { usePinnedScroll } from "@/hooks/usePinnedScroll";
import { useProjects } from "@/hooks/useProjects";
import { useSessionHome } from "@/hooks/useSessionHome";
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
  compactPane?: boolean;
  visible?: boolean;
  workspaceActions?: ReactNode;
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
export function ChatPanel({
  open,
  onToggle,
  embedded = false,
  onClose,
  fullscreen = false,
  compactPane = false,
  visible = true,
  workspaceActions,
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
  } = useChat();
  const session = useQuery({
    queryKey: ["chat-threads", "session", thread?.id],
    queryFn: () => api.chat.session(thread?.id ?? ""),
    enabled: !!thread?.runtimeId,
  });
  const answers = session.data?.queued ?? [];
  const sessionChanged = !!session.data?.changed && !streaming && !refreshing;
  const turnElsewhere = !!session.data?.running && !streaming && !refreshing;
  useEffect(() => {
    if (turnElsewhere) void refresh();
  }, [turnElsewhere, refresh]);
  const reload = async () => {
    await refresh(sessionChanged);
    void session.refetch();
  };
  const terminalControl = useChatContinueInTerminal(fullscreen);
  const desktop = useBreakpoint("xl");
  const phone = !useBreakpoint("sm");
  const home = useSessionHome();
  const docked = fullscreen && desktop && !compactPane && !home.listHidden;
  const rail = fullscreen && desktop && !compactPane && home.listHidden;
  const context = useSessionContext(fullscreen ? home.terminalId : null, home.liveId);
  const terminalCenter = fullscreen && !!home.terminalId;
  const nativeCenter = !!home.liveId;
  const unrelatedTerminal =
    terminalCenter &&
    context.terminal &&
    !(
      thread?.runtimeId &&
      context.session?.session_id === thread.runtimeId &&
      context.session.agent === config.agent &&
      context.session.host === thread.host
    )
      ? context.terminal
      : undefined;
  const linkError = useSessionLiveLink(home, open, fullscreen);
  const title = nativeCenter
    ? (context.session?.name ?? "Session")
    : terminalCenter
      ? (context.terminal?.name ?? "Terminal")
      : thread?.title;
  const projects = useProjects();
  const recordedOwner =
    terminalCenter || nativeCenter
      ? context.session?.project_id
      : (thread?.projectId ?? tabs.find((tab) => tab.key === activeKey)?.projectId);
  const owner =
    recordedOwner ?? projectForFolder(context.cwd, projects.data ?? [])?.id ?? recordedOwner;
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
    if (terminalCenter || !ready || (!draft.trim() && !files.length)) return;
    if (!streaming) scroll.pinToBottom();
    void send(draft);
    setDraft("");
  };
  const header = useRef<HTMLElement>(null);
  const [headerWide, setHeaderWide] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsMounted, setSettingsMounted] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  useEffect(() => {
    if (!open || headerWide) setActionsOpen(false);
  }, [open, headerWide]);
  useLayoutEffect(() => {
    if (!open || !header.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setHeaderWide((entry?.contentRect.width ?? 0) >= 620),
    );
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
      data-thread-id={nativeCenter ? "" : (thread?.id ?? "")}
      data-live-session-id={home.liveId ?? undefined}
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
        enabled={open && visible}
        docked={docked}
        rail={rail}
        wide={fullscreen && !desktop}
        home={fullscreen ? home : undefined}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header
          ref={header}
          className={cn(
            "chat-header flex min-h-12 shrink-0 items-center gap-1 px-3 py-1",
            !docked && !rail && "pl-40",
          )}
        >
          {!(fullscreen && phone) && (title || fullscreen) ? (
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
          {streaming && !nativeCenter && (
            <LoaderCircle
              size={14}
              aria-hidden="true"
              className="chat-compact-activity shrink-0 text-progress"
            />
          )}
          {fullscreen && (
            <fieldset
              aria-label="Session representation"
              className="flex shrink-0 items-center rounded-md bg-surface p-0.5"
            >
              {terminalCenter && context.terminal ? (
                <ContinueInChat terminal={context.terminal} inWorkspace showLabel />
              ) : (
                <button
                  type="button"
                  aria-pressed="true"
                  className={cn(iconButton, "gap-1 px-2 bg-surface-highest")}
                >
                  <MessageSquare size={15} />
                  <span className="hidden sm:inline">Chat</span>
                </button>
              )}
              <button
                type="button"
                data-testid="session-view-terminal"
                aria-label="Show terminal"
                aria-pressed={terminalCenter}
                disabled={
                  nativeCenter ||
                  (!terminalCenter && (!terminalControl.available || terminalControl.disabled))
                }
                title={
                  terminalCenter
                    ? "Same session terminal"
                    : "Continue this runtime in terminal after the response finishes"
                }
                onClick={() => {
                  if (!terminalCenter) void terminalControl.open();
                }}
                className={cn(iconButton, "gap-1 px-2", terminalCenter && "bg-surface-highest")}
              >
                <SquareTerminal size={15} />
                <span className="hidden sm:inline">Terminal</span>
              </button>
            </fieldset>
          )}
          {terminalCenter || nativeCenter ? null : headerWide ? (
            <div data-testid="chat-header-actions" className="flex shrink-0 items-center gap-1">
              <ActionHelp label="Refresh session">
                <button
                  type="button"
                  data-testid="chat-refresh-button"
                  onClick={() => void reload()}
                  disabled={!thread || refreshing}
                  className={cn(iconButton, sessionChanged && "text-warning")}
                  data-stale={sessionChanged || undefined}
                  aria-label={
                    sessionChanged
                      ? "Refresh session: it changed outside this chat"
                      : "Refresh session"
                  }
                >
                  <RefreshCw
                    size={17}
                    className={refreshing || reconnecting ? "animate-spin" : undefined}
                  />
                </button>
              </ActionHelp>
              <ChatContinueInTerminal control={terminalControl} />
              {supportsManualCompaction(config.agent) && (
                <ActionHelp label="Compact context">
                  <button
                    type="button"
                    data-testid="chat-compact-button"
                    aria-label="Compact context"
                    className={iconButton}
                    disabled={
                      !thread?.runtimeId ||
                      streaming ||
                      reconnecting ||
                      refreshing ||
                      queued.length > 0 ||
                      files.length > 0
                    }
                    onClick={() => void send("/compact")}
                  >
                    <ChevronsDownUp size={17} />
                  </button>
                </ActionHelp>
              )}
              <ActionHelp label="Session settings">
                <button
                  type="button"
                  data-testid="chat-config-button"
                  aria-label="Session settings"
                  className={iconButton}
                  onClick={() => setSettingsDialogOpen(true)}
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
                <button
                  type="button"
                  data-testid="chat-refresh-button"
                  onClick={() => {
                    setActionsOpen(false);
                    void reload();
                  }}
                  disabled={!thread || refreshing}
                  className={cn(actionButton, sessionChanged && "text-warning")}
                  data-stale={sessionChanged || undefined}
                  aria-label={
                    sessionChanged
                      ? "Refresh session: it changed outside this chat"
                      : "Refresh session"
                  }
                >
                  <RefreshCw
                    size={17}
                    className={refreshing || reconnecting ? "animate-spin" : undefined}
                  />
                  Refresh session
                </button>
                <ChatContinueInTerminal
                  control={terminalControl}
                  onOpen={() => setActionsOpen(false)}
                  labelled
                />
                {supportsManualCompaction(config.agent) && (
                  <button
                    type="button"
                    data-testid="chat-compact-button"
                    className={actionButton}
                    disabled={
                      !thread?.runtimeId ||
                      streaming ||
                      reconnecting ||
                      refreshing ||
                      queued.length > 0 ||
                      files.length > 0
                    }
                    onClick={() => {
                      setActionsOpen(false);
                      void send("/compact");
                    }}
                  >
                    <ChevronsDownUp size={17} />
                    Compact context
                  </button>
                )}
                <button
                  type="button"
                  data-testid="chat-config-button"
                  aria-label="Session settings"
                  className={actionButton}
                  onClick={() => {
                    setActionsOpen(false);
                    setSettingsDialogOpen(true);
                  }}
                >
                  <Settings2 size={17} />
                  Session settings
                </button>
              </PopoverContent>
            </Popover>
          )}
          {workspaceActions}
          {fullscreen && !phone && !terminalCenter && <SessionHomeToggles home={home} />}
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
          <AgentNotificationBell />
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
        {fullscreen && phone && (
          <div className="flex min-w-0 shrink-0 items-center gap-1 px-4 pb-1">
            <h2
              className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px]"
              title={`${projectName} / ${title ?? "New session"}`}
            >
              <span
                data-testid="session-project-breadcrumb"
                className="max-w-[40%] truncate text-muted-foreground"
              >
                {projectName}
              </span>
              <span aria-hidden="true" className="text-muted-foreground">
                /
              </span>
              <span className="min-w-0 truncate">{title ?? "New session"}</span>
            </h2>
            {!terminalCenter && <SessionHomeToggles home={home} />}
          </div>
        )}
        <ChatConversationInfo
          open={settingsDialogOpen}
          onOpenChange={setSettingsDialogOpen}
          terminalOnly={unrelatedTerminal}
        />
        {linkError && !nativeCenter && (
          <p role="alert" className="px-4 py-1 text-xs text-error">
            {linkError}
          </p>
        )}
        <div className="flex min-h-0 flex-1 flex-col">
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
            {home.liveId && (
              <LiveSessionDetail
                key={home.liveId}
                embedded
                sessionId={home.liveId}
                initialQuery=""
                resumeNotice={linkError || "Opening session…"}
                onClose={() => home.go({ liveId: null })}
              />
            )}
            {terminalCenter && <SessionTerminalCenter context={context} />}
            <ThreadPrimitive.Viewport
              ref={scroll.viewportRef}
              autoScroll={false}
              scrollToBottomOnRunStart={false}
              scrollToBottomOnInitialize={false}
              scrollToBottomOnThreadSwitch={false}
              data-testid="chat-messages"
              data-pinned={scroll.pinned}
              className={cn(
                "chat-messages relative flex-1 min-h-0 overflow-y-auto px-4 py-5 sm:px-6",
                (terminalCenter || nativeCenter) && "hidden",
              )}
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
                          <ChatActivityList
                            value={message.metadata.custom.activity}
                            turn={message.metadata.custom.turn}
                            live={message.metadata.custom.live === true}
                          />
                          <ChatAttachments value={message.metadata.custom.attachments} />
                          <MessagePrimitive.Parts components={textParts} />
                        </div>
                      </div>
                    </MessagePrimitive.Root>
                  )}
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
          {streaming && !nativeCenter && (
            <ChatLiveStatus
              agent={streamingAgent}
              startedAt={turn?.startedAt}
              activity={activity}
            />
          )}
          {!nativeCenter && (
            <ChatLiveAnnouncer
              streaming={streaming}
              agent={streamingAgent}
              text={streamText}
              last={messages[messages.length - 1]}
            />
          )}
          {error && !nativeCenter && (
            <div
              role="alert"
              data-testid="chat-error"
              className="shrink-0 max-h-32 overflow-auto border-t border-outline-variant px-4 py-3 text-sm text-error wrap-break-word"
            >
              {error}
            </div>
          )}
          {!nativeCenter && (permission || question) && (
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
          {!nativeCenter && queued.length + answers.length > 0 && (
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
          <div
            className={cn(
              "chat-composer-footer relative w-full shrink-0",
              nativeCenter && "hidden",
              terminalCenter ? "border-t border-border px-2 py-1" : "px-4 pt-2 pb-3 sm:px-6",
            )}
          >
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
              className={cn(
                "chat-composer-box mx-auto w-full max-w-3xl",
                terminalCenter
                  ? "bg-background"
                  : "rounded-2xl border border-border bg-surface p-2 focus-within:ring-2 focus-within:ring-focus",
              )}
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
              {settingsMounted && (
                <ChatConversationInfo
                  inline
                  open={settingsOpen}
                  onOpenChange={setSettingsOpen}
                  terminalOnly={unrelatedTerminal}
                />
              )}
              <ChatPromptMenu {...promptMenu} />
              <div className={cn("relative", terminalCenter && "hidden")}>
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
                  disabled={!ready || terminalCenter}
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
                  <button
                    type="button"
                    data-testid="composer-settings"
                    aria-label="Session settings"
                    aria-expanded={settingsOpen}
                    onClick={() => {
                      setSettingsMounted(true);
                      setSettingsOpen((value) => !value);
                    }}
                    className={iconButton}
                  >
                    <Settings2 size={16} />
                  </button>
                  <button
                    type="button"
                    data-testid="composer-refresh"
                    aria-label="Refresh session"
                    disabled={!thread || refreshing}
                    onClick={() => void reload()}
                    className={cn(iconButton, sessionChanged && "text-warning")}
                  >
                    <RefreshCw size={16} className={refreshing ? "animate-spin" : undefined} />
                  </button>
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
                  <ChatWorkspaceControls context={context} />
                  {unrelatedTerminal ? (
                    <span className="px-2 text-xs text-muted-foreground">
                      {unrelatedTerminal.kind}
                    </span>
                  ) : (
                    <>
                      <ChatAgentModelPicker key={thread?.id ?? "new"} />
                      <ChatPermissionChip />
                    </>
                  )}
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
                  {!terminalCenter && (
                    <ActionHelp label={streaming ? "Queue message" : "Send message"}>
                      <button
                        type="submit"
                        disabled={terminalCenter || !ready || (!draft.trim() && !files.length)}
                        data-testid="chat-send-button"
                        aria-label={streaming ? "Queue message" : "Send message"}
                        className="chat-send-button inline-flex min-h-8 min-w-8 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-40"
                      >
                        <ArrowUp size={18} />
                      </button>
                    </ActionHelp>
                  )}
                </div>
              </div>
            </form>
          </div>
        </div>
        {fullscreen && !terminalCenter && home.drawer && <SessionDrawer context={context} />}
      </div>
      {fullscreen && <SessionInspector context={context} home={home} narrow={!desktop} />}
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
