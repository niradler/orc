import { MessagePrimitive, ThreadPrimitive } from "@assistant-ui/react";
import { agentLabel, supportsManualCompaction } from "@orc/core/coding-agents";
import { sessionMessageHookSupported } from "@orc/core/session-messages";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ChartColumn,
  ChevronDown,
  ChevronsDownUp,
  Focus,
  History,
  ListPlus,
  LoaderCircle,
  Maximize2,
  MoreHorizontal,
  Paperclip,
  Pencil,
  RefreshCw,
  Settings2,
  SkipForward,
  Square,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/api/client";
import { ActionHelp } from "@/components/ActionHelp";
import { AgentMessageText, AgentTextStreamProvider } from "@/components/AgentMessageText";
import { ChatActivityList } from "@/components/ChatActivityList";
import { ChatAgentModelPicker } from "@/components/ChatAgentModelPicker";
import { ChatPermissionPrompt, ChatPlanReview } from "@/components/ChatApprovalCard";
import { ChatAttachments } from "@/components/ChatAttachments";
import { ChatBackgroundWork } from "@/components/ChatBackgroundWork";
import {
  ChatContinueInTerminal,
  useChatContinueInTerminal,
} from "@/components/ChatContinueInTerminal";
import { ChatSessionPicker } from "@/components/ChatControls";
import { ChatConversationInfo } from "@/components/ChatConversationInfo";
import {
  ChatDictationButton,
  ChatDictationPill,
  isDictationShortcut,
  useDictation,
} from "@/components/ChatDictation";
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
import { ChatSelectionToolbar } from "@/components/ChatSelectionToolbar";
import { ChatSessionAnalytics } from "@/components/ChatSessionAnalytics";
import { ChatContextMeter, useChatContextUsage } from "@/components/ChatSessionStrip";
import { ChatTurnDivider } from "@/components/ChatTurnMeta";
import {
  ChatVoiceButton,
  ChatVoiceOverlay,
  isVoiceShortcut,
  useVoiceMode,
} from "@/components/ChatVoiceMode";
import { ChatWorkspaceControls } from "@/components/ChatWorkspaceControls";
import { CreateTaskDialog } from "@/components/CreateTaskDialog";
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
import { SessionMessageInbox } from "@/components/SessionMessageInbox";
import { SessionView } from "@/components/SessionView";
import { StateBadge } from "@/components/StateBadge";
import { ScratchpadFormDialog } from "@/components/scratchpad/ScratchpadFormDialog";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useChat } from "@/hooks/useChat";
import { useBreakpoint } from "@/hooks/useMediaQuery";
import { useOpenLiveSession } from "@/hooks/useOpenLiveSession";
import { usePanelWidth } from "@/hooks/usePanelWidth";
import { usePinnedScroll } from "@/hooks/usePinnedScroll";
import { useProjects } from "@/hooks/useProjects";
import { useSessionHome } from "@/hooks/useSessionHome";
import {
  useSendSessionMessage,
  useSessionChildren,
  useSessionLineage,
  useSessionSubagents,
} from "@/hooks/useSessions";
import { useCompactViewport } from "@/hooks/useVisualViewport";
import {
  type AgentState,
  chatSessionState,
  liveSessionState,
  pendingLabel,
} from "@/lib/agent-state";
import { chatBackgroundWork } from "@/lib/chat-background";
import { commandSegments } from "@/lib/chat-commands";
import { chatDividers } from "@/lib/chat-dividers";
import { groupChatMessages } from "@/lib/chat-message-groups";
import {
  appendDraftQuote,
  boundedText,
  type ChatSelectionAction,
  quoteDraft,
  SELECTION_CAPTURE_LIMIT,
  type SelectionSource,
  selectionTitle,
  taskBody,
} from "@/lib/chat-selection";
import { pastedTextName, shouldAttachPaste } from "@/lib/composer-chips";
import {
  type ComposerBox,
  composerHandoff,
  composerHandoffTransform,
} from "@/lib/composer-handoff";
import { THIS_SERVER } from "@/lib/host-labels";
import { scratchpadPath } from "@/lib/scratchpad-routes";
import { matchSubagents } from "@/lib/subagent-links";
import { cn } from "@/lib/utils";

// The highlight layer must wrap text exactly like the textarea above it.
const composerText = "p-2 text-base leading-relaxed [scrollbar-gutter:stable]";
// Three rows of 16px text at leading-relaxed, plus the composer's own padding.
const HERO_INPUT_HEIGHT = 96;

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

function ChatAnalyticsAction({
  row = false,
  large = false,
  disabled,
  onOpen,
}: {
  row?: boolean;
  large?: boolean;
  disabled: boolean;
  onOpen: () => void;
}) {
  const button = (
    <button
      type="button"
      data-testid="chat-analytics-button"
      onClick={onOpen}
      disabled={disabled}
      className={cn(row ? actionButton : iconButton, large && "min-h-11 min-w-11")}
      aria-label="Session analytics"
    >
      <ChartColumn size={17} />
      {row && "Session analytics"}
    </button>
  );
  return row ? button : <ActionHelp label="Session analytics">{button}</ActionHelp>;
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
    deliver,
    steer,
    canSteerLive,
    steerAvailable,
    cancel,
    projectId,
    openThread,
  } = useChat();
  const session = useQuery({
    queryKey: ["chat-threads", "session", thread?.id],
    queryFn: () => api.chat.session(thread?.id ?? ""),
    enabled: !!thread?.runtimeId,
    // A claim that went stale while this tab was away is re-verified on focus
    // instead of popping the working panel on an idle session.
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const answers = session.data?.queued ?? [];
  const sessionChanged = !!session.data?.changed && !streaming && !refreshing;
  const agentRunning =
    session.data?.live?.status === "running" && session.data.live.agent !== "codex" && !streaming;
  const agentInbox =
    agentRunning && session.data?.live && sessionMessageHookSupported(session.data.live.agent)
      ? session.data.live
      : null;
  // The watcher's "running" claim can go stale (the agent finished or died without a
  // status update). Never hard-lock the composer on it: offer an explicit override.
  const [agentOverride, setAgentOverride] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the deps are change triggers, not reads — drop the override when the thread or its running claim changes
  useEffect(() => {
    setAgentOverride(false);
  }, [thread?.id, session.data?.live?.status]);
  const agentBlocked = agentRunning && !agentInbox && !agentOverride;
  const queueToAgent = useSendSessionMessage(agentInbox?.id ?? null);
  const runElsewhere = !!session.data?.running && !streaming && !refreshing;
  const turnElsewhere = runElsewhere || (agentRunning && !refreshing);
  // The usage API only knows sessions it discovered from an agent or terminal.
  const contextUsage = useChatContextUsage(thread?.sourceId, streaming);
  const runClaim =
    !!session.data?.running ||
    (session.data?.live?.status === "running" && session.data.live.agent !== "codex");
  const sessionState: AgentState | null = chatSessionState({
    needsYou: !!permission || !!question,
    failed: !!error,
    streaming,
    reconnecting,
    refreshing,
    turnElsewhere,
    runClaim,
    hasThread: !!thread,
  });
  const forkDisabledReason =
    streaming || refreshing || reconnecting || turnElsewhere
      ? "Wait for the current response to finish before forking."
      : undefined;
  const followedChange = useRef(0);
  useEffect(() => {
    if (!sessionChanged || !thread || error) return;
    if (followedChange.current === session.dataUpdatedAt) return;
    followedChange.current = session.dataUpdatedAt;
    void refresh(true).finally(() => session.refetch());
  }, [sessionChanged, thread, error, refresh, session.dataUpdatedAt, session.refetch]);
  const followedSession = useRef<string | null>(null);
  useEffect(() => {
    if (!session.data?.running) followedSession.current = null;
    if (!runElsewhere || !thread || followedSession.current === thread.id) return;
    followedSession.current = thread.id;
    void refresh().finally(() => session.refetch());
  }, [runElsewhere, refresh, thread, session.data?.running, session.refetch]);
  const reload = async () => {
    await refresh(sessionChanged);
    void session.refetch();
  };
  const children = useSessionChildren(thread?.id ?? null);
  const lastMessage = messages[messages.length - 1];
  const background = chatBackgroundWork(
    streaming ? activity : lastMessage?.role === "assistant" ? (lastMessage.activity ?? []) : [],
    children.data ?? [],
  );
  const queryClient = useQueryClient();
  const [backgroundError, setBackgroundError] = useState<string | null>(null);
  const openBackground = async (sessionId: string) => {
    setBackgroundError(null);
    try {
      openThread(await api.chat.get(sessionId));
    } catch (cause) {
      setBackgroundError(
        cause instanceof Error ? cause.message : "That session could not be opened.",
      );
    }
  };
  const stopBackground = async (sessionId: string) => {
    setBackgroundError(null);
    try {
      await api.sessions.stop(sessionId);
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
    } catch (cause) {
      setBackgroundError(
        cause instanceof Error ? cause.message : "That session could not be stopped.",
      );
    }
  };
  const home = useSessionHome();
  const lineage = useSessionLineage(thread?.sourceId ? thread.id : null);
  const parentSession = thread?.sourceId ? (lineage.data?.parent ?? null) : null;
  const openSession = useOpenLiveSession();
  const [parentOpening, setParentOpening] = useState(false);
  const [parentError, setParentError] = useState<string | null>(null);
  const openParent = async () => {
    if (!parentSession || parentOpening) return;
    setParentOpening(true);
    setParentError(null);
    try {
      if (parentSession.kind === "chat") {
        const next = await api.chat.get(parentSession.id);
        openThread(next);
        home.go({ viewId: null, terminalId: null, liveId: null }, { chatThread: next.id });
      } else await openSession(parentSession.id);
    } catch (cause) {
      setParentError(
        cause instanceof Error ? cause.message : "The parent session could not be opened.",
      );
    } finally {
      setParentOpening(false);
    }
  };
  const terminalControl = useChatContinueInTerminal({
    inChat: true,
    onOpened: (terminal) => home.go({ terminalId: terminal.id }),
  });
  const desktop = useBreakpoint("xl");
  const phone = !useBreakpoint("md");
  const compactViewport = useCompactViewport();
  // Focus chat is in-memory view state for the open conversation, never a saved
  // global mode: another chat, a closed chat or a reload starts unfocused.
  const [focusChat, setFocusChat] = useState(false);
  const focusScope = `${activeKey}:${open ? "open" : "closed"}`;
  const [focusAt, setFocusAt] = useState(focusScope);
  if (focusAt !== focusScope) {
    // Adjust during render so a new or closed chat never paints one focused frame.
    setFocusAt(focusScope);
    setFocusChat(false);
  }
  // A blank thread puts the heading and composer together around the middle.
  // The software keyboard compacts the viewport, and then the composer docks so
  // it stays reachable instead of pushing the hero off screen.
  const hero = messages.length === 0 && !streaming && !editingQueuedId && !compactViewport;
  const composerBox = useRef<HTMLFormElement>(null);
  // The hero rectangle of the composer, measured after layout-changing renders so
  // typing in the hero does not skew the handoff. Streaming tokens do not change
  // the key, so they never read layout. Only the first send arms the animation.
  const composerLayout = useRef<{ hero: boolean; scope: string; box: ComposerBox } | null>(null);
  const composerLayoutKey = useRef("");
  const layoutKey = `${hero}:${open ? 1 : 0}:${activeKey}:${thread?.id ?? ""}:${draft.length}:${files.length}:${compactViewport ? 1 : 0}`;
  const handoffArmed = useRef(false);
  useLayoutEffect(() => {
    if (composerLayoutKey.current === layoutKey) return;
    composerLayoutKey.current = layoutKey;
    const node = composerBox.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const box: ComposerBox = {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
    const scope = `${activeKey}:${thread?.id ?? ""}`;
    const previous = composerLayout.current;
    composerLayout.current = { hero, scope, box };
    if (!handoffArmed.current || hero || !previous?.hero || previous.scope !== scope) return;
    handoffArmed.current = false;
    if (!open || document.hidden || !box.width || !box.height) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const handoff = composerHandoff(previous.box, box);
    if (!handoff) return;
    // 180 ms ease-out: the docked composer starts where the hero was. Web
    // Animations leaves no transform behind once it finishes.
    node.animate([{ transform: composerHandoffTransform(handoff) }, { transform: "none" }], {
      duration: 180,
      easing: "ease-out",
    });
  });
  const docked = fullscreen && desktop && !home.listHidden;
  const rail = fullscreen && desktop && home.listHidden;
  const terminalCenter = !!home.terminalId;
  const viewId = fullscreen && !terminalCenter ? home.viewId : null;
  const viewed = useQuery({
    queryKey: ["sessions", "live-one", viewId],
    queryFn: () => api.sessions.liveOne(viewId as string),
    enabled: !!viewId,
    retry: false,
  }).data;
  const context = useSessionContext(
    home.terminalId,
    viewId ? { id: viewId, session: viewed } : undefined,
  );
  // The drawer can take the conversation's space; collapsing or closing it
  // returns the column to the chat instead of leaving a half-empty screen.
  const [drawerExpanded, setDrawerExpanded] = useState(false);
  useEffect(() => {
    if (!home.drawer) setDrawerExpanded(false);
  }, [home.drawer]);
  // A session switch starts the drawer at its normal height again.
  const drawerSessionKey = useRef(activeKey);
  useEffect(() => {
    if (drawerSessionKey.current === activeKey) return;
    drawerSessionKey.current = activeKey;
    setDrawerExpanded(false);
  }, [activeKey]);
  const closeDrawer = () => {
    setDrawerExpanded(false);
    home.go({ drawer: false });
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>('[data-testid="session-drawer-toggle"]')
        ?.focus({ preventScroll: true }),
    );
  };
  const linkError = useSessionLiveLink(home, fullscreen);
  const title = terminalCenter
    ? (context.terminal?.name ?? "Terminal")
    : viewId
      ? (viewed?.name ?? "Session")
      : thread?.title;
  const headerState = viewId ? (viewed ? liveSessionState(viewed) : null) : sessionState;
  const dividers = useMemo(() => {
    const raw = chatDividers(messages, contextUsage.data?.compactions ?? []);
    const { displayId } = groupChatMessages(messages);
    const byMessage = new Map<string, typeof raw.trailing>();
    for (const [id, list] of raw.byMessage) {
      const key = displayId.get(id) ?? id;
      byMessage.set(key, [...(byMessage.get(key) ?? []), ...list]);
    }
    return { byMessage, trailing: raw.trailing };
  }, [messages, contextUsage.data?.compactions]);
  const storedMessages = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );
  // What an attribution line needs from a message the user selected text in.
  const messageSources = useMemo(
    () =>
      new Map(
        messages.map((message) => [
          message.id,
          { agent: message.agent, role: message.role, timestamp: message.timestamp },
        ]),
      ),
    [messages],
  );
  const { data: subagents } = useSessionSubagents(thread?.sourceId ?? thread?.id ?? null);
  const subagentLinks = useMemo(
    () => matchSubagents(messages, subagents ?? []),
    [messages, subagents],
  );
  const lastAssistant = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message?.role === "assistant") return message;
    }
    return undefined;
  }, [messages]);
  const contextWindow = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index--) {
      const window = messages[index]?.turn?.usage?.context_window;
      if (window) return window;
    }
    return undefined;
  }, [messages]);
  // The latest recorded request belongs to the newest assistant turn only when it
  // was recorded after that turn started; otherwise the figure belongs elsewhere.
  const latestUsage = contextUsage.data?.latest ?? null;
  const latestUsageAt = latestUsage?.recorded_at ? Date.parse(latestUsage.recorded_at) : Number.NaN;
  // A finished turn carries a frozen token figure; only a still-live turn reads the
  // session's latest recorded request, so completed turns stop drifting upward.
  const frozenUsage = lastAssistant?.turn?.usage;
  const turnUsage = frozenUsage
    ? frozenUsage
    : latestUsage &&
        Number.isFinite(latestUsageAt) &&
        lastAssistant?.turn &&
        latestUsageAt >= lastAssistant.turn.startedAt
      ? latestUsage
      : null;
  const projects = useProjects();
  const owner = terminalCenter
    ? context.session?.project_id
    : viewId
      ? viewed?.project_id
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
  const sendLabel = agentInbox
    ? "Queue for its next safe point"
    : agentBlocked
      ? "Running in its own agent; send when it finishes"
      : !streaming
        ? "Send message"
        : canSteerLive
          ? "Send now"
          : "Queue message";
  const submit = () => {
    if (dictation.busy) return;
    if (agentInbox) {
      const body = draft.trim();
      if (!body || files.length || queueToAgent.isPending) return;
      setDraft("");
      queueToAgent.mutate(body, {
        onError: () => setDraft((current) => (current === "" ? body : current)),
      });
      return;
    }
    if (!ready || agentBlocked || (!draft.trim() && !files.length)) return;
    if (!streaming) scroll.pinToBottom();
    // The first message docks the hero composer; animate that one move only.
    if (hero) handoffArmed.current = true;
    const text = draft;
    setDraft("");
    // A failed steer keeps the text so the user can retry; a queued or steered
    // message already left the composer.
    void deliver(text).then((outcome) => {
      if (outcome === "failed") {
        handoffArmed.current = false;
        setDraft((current) => (current === "" ? text : current));
      }
    });
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
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
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
      <button
        type="button"
        data-testid="chat-focus-menu"
        aria-pressed={focusChat}
        className={actionButton}
        onClick={() => {
          setActionsOpen(false);
          setFocusChat((value) => !value);
        }}
      >
        <Focus size={17} />
        {focusChat ? "Exit focus chat" : "Focus chat"}
      </button>
      {!terminalCenter && (
        <ChatContinueInTerminal
          control={terminalControl}
          onOpen={() => setActionsOpen(false)}
          labelled
        />
      )}
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
          <ChatAnalyticsAction
            row
            disabled={!thread}
            onOpen={() => {
              setActionsOpen(false);
              setAnalyticsOpen(true);
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
  const dictation = useDictation(input, setDraft);
  const voice = useVoiceMode(thread?.id, streaming);
  const activeCommandOption = promptMenu.matches[promptMenu.index];
  const promptMenuOpen = useRef(false);
  promptMenuOpen.current = promptMenu.open;
  // Escape leaves focus chat, except while an overlay or an IME composition owns
  // the key: a dialog, a menu, the prompt list, the selection toolbar or IME.
  useEffect(() => {
    if (!focusChat) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      // A popover, dialog or menu consumed the key first; it closes, focus stays.
      if (event.defaultPrevented) return;
      if (promptMenuOpen.current) return;
      if (
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-testid="chat-selection-toolbar"]',
        )
      )
        return;
      setFocusChat(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [focusChat]);
  const inputBackdrop = useRef<HTMLDivElement>(null);
  const plainPaste = useRef(false);
  const [taskFromSelection, setTaskFromSelection] = useState<{
    title: string;
    body: string;
  } | null>(null);
  const [padFromSelection, setPadFromSelection] = useState<{
    title: string;
    content: string;
  } | null>(null);
  const [savedPad, setSavedPad] = useState<{ id: string; title: string } | null>(null);
  const lastActiveKey = useRef(activeKey);
  useEffect(() => {
    if (lastActiveKey.current === activeKey) return;
    lastActiveKey.current = activeKey;
    setSavedPad(null);
  }, [activeKey]);
  // Selection actions insert into the active tab's draft, so they survive a
  // tab switch like text the user typed there.
  const actOnSelection = useCallback(
    (action: ChatSelectionAction, text: string, source: SelectionSource) => {
      const bounded = boundedText(text, SELECTION_CAPTURE_LIMIT);
      if (!bounded) return;
      setSavedPad(null);
      if (action === "ask") {
        setDraft((current) => appendDraftQuote(current, quoteDraft(bounded, source)));
        window.requestAnimationFrame(() => {
          const field = input.current;
          if (!field) return;
          field.focus();
          field.setSelectionRange(field.value.length, field.value.length);
        });
        return;
      }
      if (action === "task") {
        setTaskFromSelection({
          title: selectionTitle(bounded),
          body: taskBody(bounded, source),
        });
        return;
      }
      setPadFromSelection({
        title: selectionTitle(bounded),
        content: quoteDraft(bounded, source),
      });
    },
    [setDraft],
  );
  const resolveSelectionSource = useCallback(
    (messageId: string): SelectionSource => {
      const entry = messageSources.get(messageId);
      return {
        threadId: thread?.id,
        title: thread?.title ?? "New chat",
        // A quote from your own message is not attributed to the agent.
        agent: entry?.role === "user" ? "You" : agentLabel(entry?.agent ?? config.agent),
        timestamp: entry?.timestamp ?? Date.now(),
      };
    },
    [config.agent, messageSources, thread?.id, thread?.title],
  );
  const draftSegments = useMemo(
    () => commandSegments(draft, promptMenu.commandNames),
    [draft, promptMenu.commandNames],
  );
  const highlighted = draftSegments.some((segment) => segment.command);
  useLayoutEffect(() => {
    if (!open) return;
    // Three rows in the hero; one row once the composer is docked.
    const floor = hero ? HERO_INPUT_HEIGHT : 42;
    const measure = () => {
      if (!input.current) return;
      input.current.style.height = "auto";
      // Typed text decides its own height; an empty hero keeps three rows.
      const height = draft
        ? Math.min(Math.max(input.current.scrollHeight, 42), 160)
        : Math.min(floor, 160);
      input.current.style.height = `${height}px`;
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
  }, [draft, hero, open]);
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
  // The terminal is another view of the same chat session, not a separate page:
  // one control returns to the conversation without losing either side's state.
  const terminalBack = terminalCenter ? (
    <ActionHelp label="Back to chat">
      <button
        type="button"
        data-testid="chat-terminal-back"
        aria-label="Back to chat"
        className={cn(iconButton, phone && "min-h-11 min-w-11")}
        onClick={() => home.go({ terminalId: null }, { replace: true })}
      >
        <ArrowLeft size={18} />
      </button>
    </ActionHelp>
  ) : null;
  if (!open) return <div data-testid="chat-panel-collapsed" className="hidden" />;
  return (
    <ThreadPrimitive.Root
      data-testid="chat-panel"
      data-streaming={streaming ? "true" : "false"}
      data-focus={focusChat ? "true" : "false"}
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
              phone
                ? "flex items-center px-1 py-0.5"
                : "flex min-h-12 items-center gap-1 px-3 py-1",
              // Focus chat narrows the chrome: tighter padding, no strip detail
              // and a one-line phone title.
              focusChat && (phone ? "py-0.5" : "px-2"),
              !docked && !rail && !phone && "pl-40",
            )}
          >
            {!phone && terminalBack}
            {parentSession && (
              <ActionHelp label={`Back to ${parentSession.title}`}>
                <button
                  type="button"
                  data-testid="chat-parent-back"
                  aria-label={`Back to ${parentSession.title}`}
                  disabled={parentOpening}
                  onClick={() => void openParent()}
                  className={cn(iconButton, "shrink-0", phone && "min-h-11 min-w-11")}
                >
                  <ArrowLeft size={18} />
                </button>
              </ActionHelp>
            )}
            {phone ? (
              <>
                {terminalBack}
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
                  {!focusChat && (
                    <p className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                      {headerState && (
                        <StateBadge
                          state={headerState}
                          compact
                          testId="chat-header-state"
                          className="shrink-0"
                        />
                      )}
                      <span className="truncate">
                        <span data-testid="session-project-breadcrumb">{projectName}</span>
                        {" · "}
                        {(viewId ? viewed?.host : thread?.host) ?? THIS_SERVER}
                      </span>
                    </p>
                  )}
                </div>
                {streaming && !viewId && (
                  <LoaderCircle
                    size={14}
                    aria-hidden="true"
                    className="chat-compact-activity shrink-0 text-progress motion-safe:animate-spin"
                  />
                )}
                <SessionHomeToggles home={home} gestures />
                {!viewId && (
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
                    <PopoverContent
                      data-testid="chat-actions-menu"
                      aria-label="Session actions"
                      align="end"
                      className="flex w-56 flex-col gap-1 p-1"
                    >
                      {actionMenuRows(!terminalCenter)}
                    </PopoverContent>
                  </Popover>
                )}
              </>
            ) : title || fullscreen ? (
              <h2
                className="flex min-w-0 shrink items-center gap-1.5 text-sm font-medium"
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
            ) : null}
            {!phone && !focusChat && Boolean(title || fullscreen) && (
              <span aria-hidden="true" className="h-3 w-px shrink-0 bg-outline-variant" />
            )}
            {!phone &&
              !focusChat &&
              headerState &&
              !(headerState === "working" && headerWide && !terminalCenter && !viewId) && (
                <StateBadge
                  state={headerState}
                  compact={!headerWide}
                  testId="chat-header-state"
                  className="shrink-0"
                />
              )}
            {/* Session facts sit beside the title; actions stay at the right edge. */}
            {!phone && <div className="min-w-0 flex-1" aria-hidden="true" />}
            {!phone &&
              (terminalCenter || viewId ? null : headerWide ? (
                <div data-testid="chat-header-actions" className="flex shrink-0 items-center gap-1">
                  <ChatRefreshAction
                    stale={sessionChanged}
                    busy={refreshing || reconnecting || headerState === "working"}
                    disabled={!thread || refreshing}
                    onRefresh={() => void reload()}
                  />
                  <ChatAnalyticsAction disabled={!thread} onOpen={() => setAnalyticsOpen(true)} />
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
            {/* The chat page is a regular page: navigation (Back, the sidebar or
                another destination) leaves it, so it has no close button. */}
            {!fullscreen && (
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
          {(linkError || parentError) && (
            <p role="alert" className="px-4 py-1 text-xs text-error">
              {linkError ?? parentError}
            </p>
          )}
          {terminalCenter && <SessionTerminalCenter context={context} />}
          {viewId && (
            <div className={cn("flex min-h-0 flex-1 flex-col", drawerExpanded && "hidden")}>
              <SessionView
                key={viewId}
                sessionId={viewId}
                onResumed={() => home.go({ listOpen: false, viewId: null }, { replace: true })}
              />
            </div>
          )}
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col",
              // A blank thread centres the hero heading and composer together.
              hero && "justify-center",
              (terminalCenter || drawerExpanded || viewId) && "hidden",
            )}
          >
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
            <div className={cn("relative flex min-h-0 flex-col", !hero && "flex-1")}>
              <ChatSelectionToolbar
                resetKey={`${thread?.id ?? "new"}:${open ? "open" : "closed"}`}
                resolveSource={resolveSelectionSource}
                onAction={actOnSelection}
              />
              <ThreadPrimitive.Viewport
                ref={scroll.viewportRef}
                autoScroll={false}
                scrollToBottomOnRunStart={false}
                scrollToBottomOnInitialize={false}
                scrollToBottomOnThreadSwitch={false}
                data-testid="chat-messages"
                data-pinned={scroll.pinned}
                className={cn(
                  "chat-messages relative min-h-0 overflow-y-auto px-4 py-5 sm:px-6",
                  hero ? "flex-none py-0" : "flex-1",
                )}
              >
                <div ref={scroll.contentRef} className={cn("flex flex-col", !hero && "min-h-full")}>
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
                    <div
                      className={cn(
                        "chat-empty-state mx-auto flex w-full max-w-(--chat-width) flex-col gap-2",
                        hero ? "px-4 pt-2" : "flex-1 justify-center",
                      )}
                    >
                      <h3 className="text-lg font-medium">What are you working on?</h3>
                      <p className="max-w-xs text-sm leading-relaxed text-on-surface-variant">
                        Ask about your tasks, review agent activity, or work through a coding
                        question.
                      </p>
                    </div>
                  )}
                  <ChatForkNotice thread={thread ?? undefined} />
                  {!focusChat && <SessionLineage sessionId={thread?.id ?? null} />}
                  <ThreadPrimitive.Messages>
                    {({ message }) => {
                      const custom = message.metadata.custom;
                      const live = custom.live === true;
                      const content = typeof custom.content === "string" ? custom.content : "";
                      const stored = storedMessages.get(message.id);
                      const usage = message.id === lastAssistant?.id ? turnUsage : null;
                      return (
                        <>
                          {dividers.byMessage.get(message.id)?.map((divider, index) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: dividers are positional
                            <ChatTurnDivider key={`${divider.type}-${index}`} divider={divider} />
                          ))}
                          <MessagePrimitive.Root
                            style={{
                              contentVisibility: "auto",
                              containIntrinsicSize: "auto 120px",
                            }}
                            data-testid="chat-message"
                            data-role={message.role}
                            data-message-id={message.id}
                            className="group/message mx-auto mb-1 w-full max-w-(--chat-width) min-w-0 chat-message"
                          >
                            <div
                              className={
                                message.role === "user"
                                  ? "ml-auto w-fit max-w-[90%] rounded-2xl bg-surface px-4 py-2"
                                  : undefined
                              }
                            >
                              <div data-testid="chat-message-agent" className="sr-only">
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
                                  providerActivity={custom.providerActivity}
                                  turn={custom.turn}
                                  live={live}
                                  subagents={subagentLinks}
                                />
                                <ChatAttachments value={custom.attachments} />
                                <AgentTextStreamProvider streaming={live}>
                                  <MessagePrimitive.Parts components={textParts} />
                                </AgentTextStreamProvider>
                              </div>
                            </div>
                            {!live &&
                              (message.role === "user" ||
                                !!content.trim() ||
                                !!custom.turn ||
                                !!stored?.model ||
                                !!usage?.input_tokens) && (
                                <ChatMessageActions
                                  threadId={thread?.id}
                                  messageId={message.id}
                                  role={message.role === "user" ? "user" : "assistant"}
                                  content={content}
                                  turn={custom.turn}
                                  model={stored?.model}
                                  tokens={usage?.input_tokens}
                                  cachedTokens={usage?.cached_input_tokens}
                                  forkDisabledReason={forkDisabledReason}
                                  onForked={openThread}
                                  threadTitle={thread?.title ?? "New chat"}
                                  agent={agentLabel(
                                    typeof custom.agent === "string" ? custom.agent : config.agent,
                                  )}
                                  timestamp={stored?.timestamp ?? message.createdAt?.getTime()}
                                  onSelectionAction={actOnSelection}
                                />
                              )}
                          </MessagePrimitive.Root>
                        </>
                      );
                    }}
                  </ThreadPrimitive.Messages>
                  {dividers.trailing.map((divider, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: dividers are positional
                    <ChatTurnDivider key={`${divider.type}-${index}`} divider={divider} />
                  ))}
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
            <ChatBackgroundWork
              items={focusChat ? [] : background}
              error={backgroundError}
              onOpen={(sessionId) => void openBackground(sessionId)}
              onStop={(sessionId) => void stopBackground(sessionId)}
            />
            {focusChat && backgroundError && (
              // Focus hides the background rows, never a failure raised from them.
              <p
                role="alert"
                data-testid="chat-background-error"
                className="px-4 pb-1 text-xs text-error"
              >
                {backgroundError}
              </p>
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
                {permission &&
                  (permission.tool === "ExitPlanMode" ? (
                    <ChatPlanReview
                      key={permission.requestId}
                      {...(typeof permission.input?.plan === "string"
                        ? { plan: permission.input.plan }
                        : {})}
                      busy={responding}
                      acceptEdits
                      onApprove={(mode) =>
                        changePermissions({ ...config, permissionMode: mode }).then(() =>
                          respondPermission("approved"),
                        )
                      }
                      onRevise={(feedback) => void respondPermission("denied", feedback)}
                    />
                  ) : (
                    <ChatPermissionPrompt
                      key={permission.requestId}
                      tool={permission.tool}
                      command={permission.command}
                      busy={responding}
                      allowSession={permission.allowSession !== false}
                      feedback={thread?.capabilities?.approvalFeedback === true}
                      onRespond={(decision, feedback) => void respondPermission(decision, feedback)}
                      {...(["claude", "codex", "pi"].includes(config.agent)
                        ? {
                            onAllowAll: () =>
                              void changePermissions({
                                ...config,
                                permissionMode: "bypassPermissions",
                              }),
                          }
                        : {})}
                    />
                  ))}
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
            {!streaming &&
              !permission &&
              !question &&
              queued.length === 0 &&
              config.agent !== "claude" &&
              config.permissionMode === "plan" &&
              thread?.capabilities?.permissionModes?.includes("plan") &&
              messages[messages.length - 1]?.role === "assistant" &&
              (messages[messages.length - 1]?.turn ?? turn)?.outcome === "completed" &&
              messages[messages.length - 1]?.content && (
                <ChatPlanReview
                  key={messages[messages.length - 1]?.id}
                  busy={responding}
                  acceptEdits={thread.capabilities.permissionModes.includes("acceptEdits")}
                  onApprove={(mode) =>
                    Promise.all([
                      changePermissions({ ...config, permissionMode: mode }),
                      send("Implement the plan."),
                    ])
                  }
                  onRevise={(feedback) => void send(feedback)}
                />
              )}
            {!focusChat && queued.length + answers.length > 0 && (
              <details
                key={activeKey}
                open={queueDisclosure.key === activeKey && queueDisclosure.open}
                onToggle={(event) =>
                  setQueueDisclosure({ key: activeKey, open: event.currentTarget.open })
                }
                data-testid="chat-message-queue"
                aria-label="Pending messages"
                className="group mx-auto w-full max-w-[calc(var(--chat-width)+3rem)] shrink-0 border-t border-outline-variant px-4 sm:px-6"
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
              data-hero={hero ? "true" : "false"}
              className={cn(
                "chat-composer-footer relative w-full shrink-0 px-4 pt-2 pb-3 sm:px-6",
                // The hero gives the composer the same column and width as the
                // docked footer; only its place in the column changes.
                hero && "pt-4",
              )}
            >
              {agentRunning && (
                <div className="mx-auto mb-1.5 w-full max-w-(--chat-width) px-2">
                  <p
                    data-testid="chat-agent-running"
                    role="status"
                    className="text-xs text-on-surface-variant"
                  >
                    {agentInbox
                      ? agentInbox.waiting_for
                        ? pendingLabel(agentInbox.waiting_for)
                        : "Running in its own agent · sends queue"
                      : agentOverride
                        ? "Sending unlocked. The running status may be stale."
                        : "Running in its own agent · send unlocks when it finishes"}
                  </p>
                  {agentBlocked && (
                    <button
                      type="button"
                      data-testid="chat-agent-send-anyway"
                      onClick={() => {
                        setAgentOverride(true);
                        void session.refetch();
                      }}
                      className="mt-0.5 text-xs text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus"
                    >
                      Still blocked? Send anyway
                    </button>
                  )}
                  {queueToAgent.error && (
                    <p role="alert" className="text-xs text-error">
                      {queueToAgent.error.message}
                    </p>
                  )}
                  {agentInbox && <SessionMessageInbox session={agentInbox} compose={false} />}
                </div>
              )}
              {streaming && (
                <p
                  role="status"
                  data-testid="chat-send-outcome"
                  className="mx-auto mb-1.5 w-full max-w-(--chat-width) px-2 text-xs text-on-surface-variant"
                >
                  {canSteerLive
                    ? "Sends steer this turn"
                    : permission
                      ? pendingLabel({ reason: "permission", tool: permission.tool })
                      : question
                        ? pendingLabel({ reason: "question", tool: null })
                        : "Sends queue until the turn ends"}
                </p>
              )}
              {savedPad && (
                <p
                  role="status"
                  data-testid="chat-selection-saved"
                  className="mx-auto mb-1.5 w-full max-w-(--chat-width) px-2 text-xs text-on-surface-variant"
                >
                  Saved to{" "}
                  <Link
                    to={scratchpadPath(savedPad.id)}
                    data-testid="chat-selection-saved-link"
                    className="text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus"
                  >
                    {savedPad.title}
                  </Link>
                </p>
              )}
              <form
                ref={composerBox}
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
                className="chat-composer-box mx-auto w-full max-w-(--chat-width) rounded-2xl border border-border bg-surface p-2 focus-within:ring-2 focus-within:ring-focus"
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
                    aria-controls={promptMenu.open ? "chat-prompt-menu" : undefined}
                    aria-activedescendant={
                      activeCommandOption ? chatCommandOptionId(activeCommandOption) : undefined
                    }
                    placeholder="Ask anything. / for commands, @ for files"
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
                      if (dictation.available && isDictationShortcut(event)) {
                        event.preventDefault();
                        dictation.toggle();
                        return;
                      }
                      if (voice.available && !dictation.busy && isVoiceShortcut(event)) {
                        event.preventDefault();
                        void voice.start();
                        return;
                      }
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
                    rows={hero ? 3 : 1}
                    className={`chat-composer-input ${composerText} relative block w-full resize-none overflow-y-auto bg-transparent placeholder:text-on-surface-variant focus-visible:outline-hidden disabled:opacity-60 ${highlighted ? "text-transparent caret-on-surface" : ""}`}
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  {voice.active && <ChatVoiceOverlay voice={voice} />}
                  {dictation.phase !== "idle" && <ChatDictationPill dictation={dictation} />}
                  <div
                    data-testid="chat-composer-tools"
                    className={cn(
                      "chat-composer-tools flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-0.5",
                      (dictation.phase !== "idle" || voice.active) && "hidden",
                    )}
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
                    <ChatDictationButton dictation={dictation} disabled={!ready} />
                    <ChatVoiceButton voice={voice} disabled={!ready || dictation.busy} />
                    <ChatAgentModelPicker key={thread?.id ?? "new"} />
                    <ChatWorkspaceControls />
                    <ChatPermissionChip />
                  </div>
                  <div className={cn("flex items-center gap-1", voice.active && "hidden")}>
                    <ChatContextMeter
                      usage={latestUsage ?? frozenUsage}
                      window={latestUsage?.context_window ?? contextWindow}
                      compactions={contextUsage.data?.compactions?.length ?? 0}
                    />
                    {streaming && canSteerLive && (
                      <ActionHelp
                        label="Queue message"
                        description="Hold this message until the current response finishes"
                      >
                        <button
                          type="button"
                          data-testid="chat-queue-button"
                          onClick={() => {
                            if (!draft.trim() && !files.length) return;
                            const text = draft;
                            setDraft("");
                            void send(text);
                          }}
                          disabled={dictation.busy || (!draft.trim() && !files.length)}
                          aria-label="Queue message"
                          className={iconButton}
                        >
                          <ListPlus size={17} />
                        </button>
                      </ActionHelp>
                    )}
                    {streaming && steerAvailable && !canSteerLive && (
                      <ActionHelp
                        label="Send now"
                        description="Send this message into the active response; ordinary Send queues it for later"
                      >
                        <button
                          type="button"
                          data-testid="chat-steer-button"
                          onClick={() => void steer()}
                          disabled={
                            dictation.busy ||
                            !draft.trim() ||
                            !!files.length ||
                            responding ||
                            !steerAvailable
                          }
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
                    <ActionHelp label={sendLabel}>
                      <button
                        type="submit"
                        disabled={
                          dictation.busy ||
                          (agentInbox
                            ? !draft.trim() || !!files.length || queueToAgent.isPending
                            : !ready || agentBlocked || (!draft.trim() && !files.length))
                        }
                        data-testid="chat-send-button"
                        aria-label={sendLabel}
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
          {fullscreen && home.drawer && !phone && (
            <SessionDrawer
              context={context}
              expanded={drawerExpanded}
              onToggleExpanded={() => setDrawerExpanded((value) => !value)}
              onClose={closeDrawer}
            />
          )}
        </div>
      </MobileChatShell>
      {fullscreen && !phone && <SessionInspector context={context} home={home} narrow={!desktop} />}
      {taskFromSelection && (
        <CreateTaskDialog
          open
          defaultProjectId={thread?.projectId}
          defaultTitle={taskFromSelection.title}
          defaultBody={taskFromSelection.body}
          onClose={() => setTaskFromSelection(null)}
        />
      )}
      {padFromSelection && (
        <ScratchpadFormDialog
          defaultProjectId={thread?.projectId ?? ""}
          defaultSessionId={thread?.sourceId ?? undefined}
          defaultTitle={padFromSelection.title}
          defaultContent={padFromSelection.content}
          onClose={() => setPadFromSelection(null)}
          onSaved={(pad) => {
            setPadFromSelection(null);
            setSavedPad({ id: pad.id, title: pad.title });
          }}
        />
      )}
      <Dialog open={analyticsOpen} onOpenChange={setAnalyticsOpen}>
        <DialogContent
          data-testid="chat-analytics-dialog"
          className="max-h-[85dvh] w-[min(56rem,calc(100vw-24px))] max-w-none overflow-y-auto"
        >
          <DialogTitle className="sr-only">Session analytics</DialogTitle>
          {analyticsOpen && <ChatSessionAnalytics threadId={thread?.id} streaming={false} />}
        </DialogContent>
      </Dialog>
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
            label="Send now, stopping this response"
            description="Stops the current response, then sends this message ahead of the rest of the queue"
          >
            <button
              type="button"
              data-testid="chat-queued-force"
              disabled={forceDisabled}
              aria-label="Send now, stopping this response"
              onClick={onForce}
              className="flex size-11 shrink-0 items-center justify-center rounded text-on-surface-variant hover:bg-surface hover:text-on-surface focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-40 sm:size-8"
            >
              <SkipForward size={14} />
            </button>
          </ActionHelp>
          {removeButton}
        </div>
      )}
    </li>
  );
}
