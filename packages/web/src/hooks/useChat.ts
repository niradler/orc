import {
  type AppendMessage,
  AssistantRuntimeProvider,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import {
  appendChatActivity,
  type ChatActivity,
  type ChatEvent,
  type ChatMessage,
  type ChatQuestion,
  ChatSettingsSchema,
  type ChatThread,
  type ChatTurn,
  type ChatWorkspace,
  ownsChatActivity,
} from "@orc/core/chat";
import type { ChatAgentOptions } from "@orc/core/chat-options";
import { projectForFolder } from "@orc/core/project-path";
import type { ProviderProfile } from "@orc/core/providers";
import { UPLOAD_MAX_BYTES, UPLOAD_MAX_FILES } from "@orc/core/session-file-types";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { ApiError, api, getApiUrl } from "@/api/client";
import { useFolderPickerSession } from "@/hooks/useFolderPickerSession";
import { useBreakpoint } from "@/hooks/useMediaQuery";
import { useProjects } from "@/hooks/useProjects";
import { API_ACCESS_CHANGED } from "@/lib/api-credentials";
import { activeApiHeaders } from "@/lib/api-hosts";
import {
  activityUpdateTarget,
  type InterjectionChange,
  withInterjection,
} from "@/lib/chat-interjection";
import { groupChatMessages } from "@/lib/chat-message-groups";
import { permissionModes } from "@/lib/composer-chips";
import { folderHistory, rememberFolder } from "@/lib/folder-history";
import { reconnectDelay, waitToReconnect } from "@/lib/reconnect";
import { getResourceConnection, subscribeResourceConnection } from "@/lib/resource-events";
import { SESSION_LIVE_PARAM } from "@/lib/session-home";
import {
  CHAT_PREFERENCES_KEY,
  CHAT_TABS_KEY,
  CHAT_THREAD_PARAM,
  type ChatConfig,
  type ChatSurface,
  chatSurfaceLinks,
  DEFAULT_CONFIG,
  initialChatSurfaceLinks,
  parseChatEvent,
  parseChatPreferences,
  parseChatTabs,
  SIDE_CHAT_THREAD_PARAM,
  withPreferences,
} from "./chat-contract";
import { type ProviderDrafts, providerSelection } from "./chat-provider-config";

export type { ChatMessage } from "@orc/core/chat";
export { CHAT_THREAD_PARAM, type ChatSurface, SIDE_CHAT_THREAD_PARAM };

function wakeOnConnectivity(wake: () => void): () => void {
  const visible = () => {
    if (document.visibilityState === "visible") wake();
  };
  const unsubscribe = subscribeResourceConnection(() => {
    if (getResourceConnection() === "connected") wake();
  });
  window.addEventListener("online", wake);
  document.addEventListener("visibilitychange", visible);
  return () => {
    unsubscribe();
    window.removeEventListener("online", wake);
    document.removeEventListener("visibilitychange", visible);
  };
}

/** The dashboard page the user is chatting from, without the chat's own URL state. */
export function currentRoute(): string {
  const params = new URLSearchParams(window.location.search);
  params.delete("chat");
  params.delete(CHAT_THREAD_PARAM);
  params.delete(SIDE_CHAT_THREAD_PARAM);
  const query = params.toString();
  const route = `${window.location.pathname}${query ? `?${query}` : ""}`;
  // The server caps the route; a page path alone still says where the user is.
  return route.length <= 2000 ? route : window.location.pathname.slice(0, 2000);
}

interface PendingPermission {
  requestId: string;
  tool: string;
  command: string;
  input?: Record<string, unknown>;
  allowSession?: boolean;
}

/** One open conversation. Each tab streams on its own, so turns keep running in the background. */
export interface ChatTab {
  workspace?: ChatWorkspace;
  createdAt?: number;
  projectId?: string | null;
  /** Closed from the open list; retained in history so drafts and background work survive. */
  hidden?: boolean;
  key: string;
  thread: ChatThread | null;
  config: ChatConfig;
  providerDrafts?: ProviderDrafts;
  messages: ChatMessage[];
  draft: string;
  files: File[];
  queuedFiles: Record<string, File[]>;
  queued: ChatMessage[];
  editingQueuedId: string | null;
  queuedDraft: string;
  queuePaused: boolean;
  queueHeld: boolean;
  historyBefore: number | null;
  loadingHistory: boolean;
  streaming: boolean;
  reconnecting: boolean;
  refreshing: boolean;
  streamText: string;
  activity: ChatActivity[];
  turn?: ChatTurn | undefined;
  error: string | null;
  permissions: PendingPermission[];
  questions: ChatQuestion[];
  runId: string;
  assistantId: string;
  /** Segments sealed by interjections in the current run; only they own routed activity. */
  interjectionSegments: string[];
  respondingAgent: string;
  /** Child sessions and native subagents with a turn in flight, from the session poll. */
  workingChildren?: number;
  /** Child sessions parked on a human question or approval. */
  waitingChildren?: number;
  /** A background turn finished or is waiting for a reply since the tab was last viewed. */
  attention: boolean;
}

/**
 * A fresh read returns only the recent window. Keep older pages the user already
 * loaded, matching them through the oldest message the window and tab share.
 */
function mergeLoadedHistory(loaded: ChatMessage[], fresh: ChatMessage[]): ChatMessage[] {
  if (!fresh.length) return loaded;
  const first = loaded.findIndex((message) => message.id === fresh[0].id);
  return first > 0 ? [...loaded.slice(0, first), ...fresh] : fresh;
}

function blankTab(config: ChatConfig, projectId?: string | null): ChatTab {
  return {
    key: crypto.randomUUID(),
    createdAt: Date.now(),
    projectId,
    thread: null,
    config,
    messages: [],
    draft: "",
    files: [],
    queuedFiles: {},
    queued: [],
    editingQueuedId: null,
    queuedDraft: "",
    queuePaused: false,
    queueHeld: false,
    historyBefore: null,
    loadingHistory: false,
    streaming: false,
    reconnecting: false,
    refreshing: false,
    streamText: "",
    activity: [],
    error: null,
    permissions: [],
    questions: [],
    runId: "",
    assistantId: "",
    interjectionSegments: [],
    respondingAgent: config.agent,
    attention: false,
  };
}
const isBlank = (tab: ChatTab) =>
  !tab.thread &&
  !tab.messages.length &&
  !tab.queued.length &&
  !tab.files.length &&
  !tab.streaming &&
  !tab.draft.trim();

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage is a convenience; chats still work without it */
  }
}
function savePreferences(config: ChatConfig): void {
  writeStorage(
    CHAT_PREFERENCES_KEY,
    JSON.stringify({
      agent: config.agent,
      providerId: config.providerId,
      model: config.model,
      ...(config.permissionMode ? { permissionMode: config.permissionMode } : {}),
    }),
  );
}
const message = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : fallback;

const BUSY_CONFLICTS = new Set([
  "This session is already responding.",
  "All chat workers are busy. Try again when a response finishes.",
  "All upload workers are busy. Try again shortly.",
]);

function waitingConflict(cause: unknown): boolean {
  return (
    cause instanceof ApiError &&
    cause.status === 409 &&
    // By code, so a live turn owned by another daemon (or one that did not stop
    // in time) queues like a local one instead of surfacing as a hard error.
    (cause.code === "SESSION_BUSY" || BUSY_CONFLICTS.has(cause.message))
  );
}

/** The server marks a steer whose text may already be in the conversation. */
const STEER_UNCONFIRMED = "STEER_UNCONFIRMED";

/** The turn is live and the backend accepted steering, whatever the send preference. */
function canSteer(tab: ChatTab): boolean {
  return (
    tab.streaming &&
    !!tab.runId &&
    tab.thread?.capabilities?.steering === true &&
    !tab.permissions.length &&
    !tab.questions.length
  );
}

/**
 * One predicate for the composer label and the send path: the turn is live, the
 * conversation steers, nothing is attached, and the backend accepted steering.
 */
function steersLive(tab: ChatTab): boolean {
  return tab.config.sendWhileRunning === "steer" && tab.files.length === 0 && canSteer(tab);
}

function useChatStore(desktopViewport: boolean) {
  const [params] = useSearchParams();
  const { pathname, search } = useLocation();
  const selectedProject = params.get("project") ?? readStorage("orc_selected_project");
  const projects = useProjects();
  const projectFolders = useMemo(
    () => (projects.data ?? []).filter((project) => project.status !== "archived" && project.scope),
    [projects.data],
  );
  const foldersRef = useRef(projectFolders);
  foldersRef.current = projectFolders;
  const projectForCwd = useCallback(
    (cwd: string | null | undefined) => projectForFolder(cwd, foldersRef.current)?.id ?? null,
    [],
  );
  const creationProject = useRef<string | null | undefined>(undefined);
  creationProject.current =
    selectedProject === "unassigned"
      ? null
      : selectedProject && selectedProject !== "all"
        ? selectedProject
        : undefined;
  const [initials] = useState(() => {
    const config = withPreferences(
      DEFAULT_CONFIG,
      parseChatPreferences(readStorage(CHAT_PREFERENCES_KEY)),
    );
    return {
      page: blankTab(config, creationProject.current),
      side: blankTab(config, creationProject.current),
    };
  });
  const [tabs, setTabs] = useState<ChatTab[]>(() => [initials.page, initials.side]);
  useEffect(() => {
    if (
      !tabs.some(
        (tab) => tab.files.length || tab.queued.some((entry) => tab.queuedFiles[entry.id]?.length),
      )
    )
      return;
    const protectUploads = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectUploads);
    return () => window.removeEventListener("beforeunload", protectUploads);
  }, [tabs]);
  const [activeKeys, setActiveKeys] = useState<Record<ChatSurface, string>>(() => ({
    page: initials.page.key,
    side: initials.side.key,
  }));
  const [ready, setReady] = useState(false);
  const [responding, setResponding] = useState(false);
  const queryClient = useQueryClient();
  const tabsRef = useRef(tabs);
  const activeKeysRef = useRef<Record<ChatSurface, string>>(activeKeys);
  const urlState = chatSurfaceLinks(pathname, search, desktopViewport);
  const visibleSurfacesRef = useRef({ page: urlState.pageShown, side: urlState.sideShown });
  visibleSurfacesRef.current = { page: urlState.pageShown, side: urlState.sideShown };
  const isTabVisible = useCallback(
    (key: string) =>
      (visibleSurfacesRef.current.page && activeKeysRef.current.page === key) ||
      (visibleSurfacesRef.current.side && activeKeysRef.current.side === key),
    [],
  );
  const isActiveElsewhere = useCallback(
    (surface: ChatSurface, key: string) =>
      activeKeysRef.current[surface === "page" ? "side" : "page"] === key,
    [],
  );
  const streams = useRef(
    new Map<string, { controller: AbortController; cancel: boolean; closed: boolean }>(),
  );
  const queueHolds = useRef(new Map<string, AbortController>());
  const defaults = useRef(initials.page.config);

  const mutate = useCallback((change: (tabs: ChatTab[]) => ChatTab[]) => {
    tabsRef.current = change(tabsRef.current);
    setTabs(tabsRef.current);
  }, []);
  const update = useCallback(
    (key: string, change: (tab: ChatTab) => Partial<ChatTab>) =>
      mutate((current) =>
        current.map((tab) => (tab.key === key ? { ...tab, ...change(tab) } : tab)),
      ),
    [mutate],
  );
  const activate = useCallback(
    (surface: ChatSurface, key: string) => {
      activeKeysRef.current = { ...activeKeysRef.current, [surface]: key };
      setActiveKeys(activeKeysRef.current);
      update(key, () => ({ attention: false, hidden: false }));
    },
    [update],
  );
  const handoff = useCallback(
    (from: ChatSurface, to: ChatSurface) => {
      if (from === to) return;
      const fromKey = activeKeysRef.current[from];
      activate(to, fromKey);
      const detached = blankTab(defaults.current, creationProject.current);
      mutate((current) => [...current, detached]);
      activate(from, detached.key);
    },
    [activate, mutate],
  );
  const find = useCallback((key: string) => tabsRef.current.find((tab) => tab.key === key), []);

  const loadSettings = useCallback(async () => {
    try {
      const preferences = await api.settings.get();
      const saved = ChatSettingsSchema.parse(preferences.chat ?? {});
      const remembered = parseChatPreferences(readStorage(CHAT_PREFERENCES_KEY));
      let resolved = withPreferences(saved, remembered);
      if (resolved.providerId) {
        const providers = await api.settings.providers.get();
        const profile = providers.providers.find(
          (item) =>
            item.id === resolved.providerId && item.agent === resolved.agent && item.enabled,
        );
        resolved = profile
          ? withPreferences(
              {
                ...saved,
                agent: profile.agent,
                providerId: profile.id,
                model: profile.model,
                agentOptions: profile.options ? { [profile.agent]: profile.options } : {},
              },
              remembered,
            )
          : saved;
      }
      defaults.current = resolved;
      mutate((current) =>
        current.map((tab) =>
          isBlank(tab) ? { ...tab, config: defaults.current, providerDrafts: undefined } : tab,
        ),
      );
      setReady(true);
    } catch (cause) {
      const text = message(cause, "Chat settings could not be loaded.");
      update(activeKeysRef.current.page, () => ({ error: text }));
      if (activeKeysRef.current.side !== activeKeysRef.current.page)
        update(activeKeysRef.current.side, () => ({ error: text }));
    }
  }, [mutate, update]);
  useEffect(() => {
    void loadSettings();
    const changed = () => {
      void loadSettings();
    };
    window.addEventListener("orc-chat-settings-changed", changed);
    return () => window.removeEventListener("orc-chat-settings-changed", changed);
  }, [loadSettings]);
  useEffect(
    () => () => {
      for (const stream of streams.current.values()) stream.controller.abort();
      streams.current.clear();
      for (const hold of queueHolds.current.values()) hold.abort();
      queueHolds.current.clear();
    },
    [],
  );

  const apply = useCallback(
    (key: string, event: ChatEvent) => {
      const background = !isTabVisible(key);
      if (event.type === "thread") {
        const stream = streams.current.get(key);
        if (stream?.cancel)
          void api.chat.cancel(event.runId).catch((cause) => {
            if (!(cause instanceof ApiError && cause.status === 409))
              update(key, () => ({
                queuePaused: true,
                error: message(cause, "The response could not be stopped."),
              }));
          });
        if (stream?.closed) {
          streams.current.delete(key);
          stream.controller.abort();
          return;
        }
        update(key, (tab) => ({
          thread: event.thread,
          runId: event.runId,
          messages: tab.messages.map((message, index) =>
            index === tab.messages.length - 1 && message.role === "user"
              ? {
                  ...message,
                  attachments: [...event.thread.messages]
                    .reverse()
                    .find((entry) => entry.role === "user")?.attachments,
                }
              : message,
          ),
        }));
      } else if (event.type === "turn") update(key, () => ({ turn: event.turn }));
      else if (event.type === "capabilities")
        update(key, (tab) => ({
          thread: tab.thread ? { ...tab.thread, capabilities: event.capabilities } : tab.thread,
        }));
      else if (event.type === "model")
        update(key, (tab) => ({
          thread: tab.thread ? { ...tab.thread, runtimeModel: event.model } : tab.thread,
        }));
      else if (event.type === "text")
        update(key, (tab) => ({ streamText: tab.streamText + event.text }));
      else if (event.type === "narration")
        update(key, (tab) => ({
          streamText: "",
          activity: appendChatActivity(tab.activity, event),
        }));
      else if (event.type === "remote")
        update(key, () => ({
          streamText: `Started on **${event.host_label}**. It keeps running there, even when this machine is off. [Open it on ${event.host_label}](${event.open_url})`,
        }));
      else if (event.type === "error") update(key, () => ({ error: event.message }));
      else if (event.type === "session")
        update(key, (tab) => ({
          thread: tab.thread ? { ...tab.thread, runtimeId: event.runtimeId } : tab.thread,
        }));
      else if (event.type === "permission_request")
        update(key, (tab) => ({
          // A reattach re-emits still-pending prompts; never stack duplicate cards.
          permissions: tab.permissions.some((request) => request.requestId === event.data.requestId)
            ? tab.permissions
            : [...tab.permissions, event.data],
          attention: tab.attention || background,
        }));
      else if (event.type === "question_request")
        update(key, (tab) => ({
          questions: tab.questions.some((request) => request.requestId === event.data.requestId)
            ? tab.questions
            : [...tab.questions, event.data],
          attention: tab.attention || background,
        }));
      else if (event.type === "request_resolved")
        update(key, (tab) => ({
          permissions: tab.permissions.filter((request) => request.requestId !== event.requestId),
          questions: tab.questions.filter((request) => request.requestId !== event.requestId),
        }));
      else if (event.type === "interjection")
        update(key, (tab) => {
          const change = withInterjection(tab, event.message);
          return change.sealedId
            ? { ...change, interjectionSegments: [...tab.interjectionSegments, change.sealedId] }
            : change;
        });
      else if (event.type !== "done")
        update(key, (tab) => {
          // A stateful update (tool result, plan, subagent) belongs to the segment
          // that owns the entry — but only segments sealed in THIS run: plan ids are
          // constant across turns, so scanning older history would rewrite the
          // previous turn's plan in place.
          if (!ownsChatActivity(tab.activity, event)) {
            const owner = activityUpdateTarget(tab.messages, tab.interjectionSegments, event);
            if (owner)
              return {
                messages: tab.messages.map((message) =>
                  message.id === owner.id
                    ? { ...message, activity: appendChatActivity(message.activity ?? [], event) }
                    : message,
                ),
              };
          }
          return { activity: appendChatActivity(tab.activity, event) };
        });
    },
    [isTabVisible, update],
  );
  const finish = useCallback(
    (key: string) =>
      update(key, (tab) => ({
        messages:
          tab.streamText || tab.activity.length || tab.turn?.outcome
            ? [
                ...tab.messages,
                {
                  id: tab.assistantId,
                  role: "assistant",
                  content: tab.streamText,
                  activity: tab.activity,
                  timestamp: Date.now(),
                  agent: tab.respondingAgent,
                  turn: tab.turn,
                },
              ]
            : tab.messages,
        streaming: false,
        reconnecting: false,
        streamText: "",
        activity: [],
        interjectionSegments: [],
        turn: undefined,
        permissions: [],
        questions: [],
        attention: tab.attention || (tab.streaming && !isTabVisible(key)),
      })),
    [isTabVisible, update],
  );
  /**
   * A finished turn is assembled locally, so its message carries a client id and
   * no persisted timing. Read the stored thread so copy, fork and duration work
   * on the message the server actually saved. Skip it once a new turn started.
   */
  const syncThread = useCallback(
    async (key: string) => {
      const threadId = find(key)?.thread?.id;
      if (!threadId) return;
      const fresh = await api.chat.get(threadId).catch(() => null);
      if (!fresh) return;
      update(key, (tab) =>
        tab.streaming && tab.thread?.id === threadId
          ? {}
          : {
              thread: fresh,
              messages: mergeLoadedHistory(tab.messages, fresh.messages),
              historyBefore: fresh.historyBefore ?? null,
            },
      );
    },
    [find, update],
  );
  /**
   * Reads one turn's events into a tab. Closing the stream detaches; the server keeps the turn.
   * Resolves false when there was no turn to follow.
   */
  const follow = useCallback(
    async (
      key: string,
      open: (signal: AbortSignal) => Promise<Response>,
      onOpen?: () => void,
      recover?: { messageId: string },
    ): Promise<boolean | "busy"> => {
      streams.current.get(key)?.controller.abort();
      const stream = { controller: new AbortController(), cancel: false, closed: false };
      streams.current.set(key, stream);
      const current = () => streams.current.get(key) === stream;
      let connect = open;
      let retried = false;
      let failures = 0;
      let busy = false;
      try {
        while (current() && !stream.controller.signal.aborted) {
          const connection = new AbortController();
          const signal = AbortSignal.any([stream.controller.signal, connection.signal]);
          // The server pings every 25s. Recover a silent connection after two missed pings.
          let idle = setTimeout(() => connection.abort(), 65_000);
          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
          try {
            const response = await connect(signal);
            if (!current()) return true;
            if (response.status === 401) window.dispatchEvent(new Event(API_ACCESS_CHANGED));
            if (response.status === 204) {
              const tab = find(key);
              const threadId = tab?.thread?.id;
              // A snapshot with an unanswered message may predate a just-finished turn.
              if (
                threadId &&
                (retried || tab?.messages[tab.messages.length - 1]?.role === "user")
              ) {
                const loaded = find(key)?.messages ?? [];
                const fresh = await api.chat.get(threadId);
                if (current())
                  update(key, () => ({
                    thread: fresh,
                    messages: mergeLoadedHistory(loaded, fresh.messages),
                    historyBefore: fresh.historyBefore ?? null,
                    streamText: "",
                    activity: [],
                    error: null,
                  }));
              }
              return false;
            }
            if (!response.ok) {
              const body: unknown = await response.json().catch(() => null);
              throw new ApiError(
                body &&
                  typeof body === "object" &&
                  "error" in body &&
                  typeof body.error === "string"
                  ? body.error
                  : `Chat request failed (HTTP ${response.status}).`,
                response.status,
                body && typeof body === "object" && "code" in body && typeof body.code === "string"
                  ? body.code
                  : null,
              );
            }
            if (!response.body) throw new Error("The agent returned no response stream.");
            onOpen?.();
            failures = 0;
            update(key, () => ({
              reconnecting: false,
              ...(retried
                ? { streamText: "", activity: [], permissions: [], questions: [], error: null }
                : {}),
            }));
            reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let completed = false;
            const consume = (line: string) => {
              const event = parseChatEvent(line);
              if (event?.type === "done") completed = true;
              else if (event) apply(key, event);
            };
            while (current() && !stream.controller.signal.aborted) {
              const { done, value } = await reader.read();
              if (!current()) return true;
              clearTimeout(idle);
              idle = setTimeout(() => connection.abort(), 65_000);
              buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";
              for (const line of lines) consume(line);
              if (done) consume(buffer);
              if (completed) return true;
              if (done) throw new Error("The chat connection ended before the reply finished.");
            }
          } catch (cause) {
            if (!current() || stream.controller.signal.aborted) return true;
            const threadId = find(key)?.thread?.id;
            if (!threadId) {
              const existingMessage =
                cause instanceof ApiError && cause.code === "CHAT_MESSAGE_EXISTS";
              if (!recover || (cause instanceof ApiError && cause.status < 500 && !existingMessage))
                throw cause;
              const slowFailure =
                existingMessage ||
                (cause instanceof ApiError && cause.status >= 500) ||
                (cause instanceof Error && cause.name === "AbortError");
              const deadline = Date.now() + (slowFailure ? 60_000 : 15_000);
              const recovery = new AbortController();
              const recoverySignal = AbortSignal.any([stream.controller.signal, recovery.signal]);
              const recoveryTimer = setTimeout(() => recovery.abort(), deadline - Date.now());
              let found: ChatThread | null = null;
              let attempts = 0;
              update(key, () => ({ reconnecting: true }));
              try {
                while (!found && current() && !recoverySignal.aborted && Date.now() < deadline) {
                  await waitToReconnect(
                    reconnectDelay(++attempts),
                    recoverySignal,
                    wakeOnConnectivity,
                  );
                  if (!current() || stream.controller.signal.aborted) return true;
                  if (recoverySignal.aborted || Date.now() >= deadline) break;
                  found = await api.chat
                    .byMessage(recover.messageId, recoverySignal)
                    .catch(() => null);
                }
              } finally {
                clearTimeout(recoveryTimer);
              }
              if (!current() || stream.controller.signal.aborted) return true;
              if (!found) throw cause;
              const adopted = found;
              update(key, () => ({
                thread: adopted,
                messages: adopted.messages,
                config: adopted.config,
                historyBefore: adopted.historyBefore ?? null,
                interjectionSegments: [],
                error: null,
              }));
              onOpen?.();
              retried = true;
              connect = (signal) =>
                fetch(`${getApiUrl()}/chat/threads/${encodeURIComponent(adopted.id)}/live`, {
                  headers: activeApiHeaders(),
                  credentials: "include",
                  signal,
                });
              continue;
            }
            if (cause instanceof ApiError && cause.status < 500) throw cause;
            retried = true;
            failures++;
            update(key, () => ({ reconnecting: true }));
            // A replay cutoff hides pre-interjection prose: refresh the stored
            // snapshot so a missed seal or human message is restored before the
            // live continuation reattaches.
            const snapshot = await api.chat.get(threadId).catch(() => null);
            if (!current() || stream.controller.signal.aborted) return true;
            if (snapshot)
              update(key, (tab) => ({
                thread: snapshot,
                messages: mergeLoadedHistory(tab.messages, snapshot.messages),
                historyBefore: snapshot.historyBefore ?? null,
                interjectionSegments: [],
                streamText: "",
                activity: [],
              }));
            // Never repeat POST /chat/stream: it may already have started a turn.
            connect = (signal) =>
              fetch(`${getApiUrl()}/chat/threads/${encodeURIComponent(threadId)}/live`, {
                headers: activeApiHeaders(),
                credentials: "include",
                signal,
              });
          } finally {
            clearTimeout(idle);
            connection.abort();
            void reader?.cancel().catch(() => {});
            reader?.releaseLock();
          }
          await waitToReconnect(
            reconnectDelay(failures),
            stream.controller.signal,
            wakeOnConnectivity,
          );
        }
        return true;
      } catch (cause) {
        if (current() && !stream.controller.signal.aborted && waitingConflict(cause)) {
          busy = true;
          return "busy";
        }
        if (current() && !stream.controller.signal.aborted)
          update(key, () => ({
            // Refresh needs a thread; a failed first send returns to the queue instead.
            error: find(key)?.thread
              ? `${message(cause, "The chat connection failed.")} Use Refresh to reconnect.`
              : cause instanceof ApiError
                ? message(cause, "The chat connection failed.")
                : "Your message didn't reach the agent.",
          }));
        return true;
      } finally {
        if (current()) {
          streams.current.delete(key);
          if (!busy) {
            finish(key);
            void syncThread(key);
          }
        }
      }
    },
    [apply, finish, syncThread, update, find],
  );
  const attach = useCallback(
    (key: string, threadId: string) =>
      follow(
        key,
        (signal) =>
          fetch(`${getApiUrl()}/chat/threads/${encodeURIComponent(threadId)}/live`, {
            headers: activeApiHeaders(),
            credentials: "include",
            signal,
          }),
        () =>
          update(key, (tab) => ({
            streaming: true,
            assistantId: crypto.randomUUID(),
            interjectionSegments: [],
            respondingAgent: tab.config.agent,
            streamText: "",
            activity: [],
            permissions: [],
            questions: [],
          })),
      ),
    [follow, update],
  );

  const refresh = useCallback(
    async (surface: ChatSurface, rebuild = false) => {
      const key = activeKeysRef.current[surface];
      const tab = find(key);
      if (!tab?.thread || tab.refreshing) return;
      update(key, () => ({ refreshing: true, error: null }));
      try {
        const fresh = await (rebuild ? api.chat.refresh : api.chat.get)(tab.thread.id);
        if (!find(key)) return;
        const previous = streams.current.get(key);
        streams.current.delete(key);
        previous?.controller.abort();
        update(key, () => ({
          thread: fresh,
          config: fresh.config,
          messages: fresh.messages,
          historyBefore: fresh.historyBefore ?? null,
          streaming: false,
          streamText: "",
          activity: [],
          permissions: [],
          questions: [],
          reconnecting: false,
        }));
        void attach(key, fresh.id);
      } catch (cause) {
        update(key, () => ({ error: message(cause, "Chat could not be refreshed.") }));
      } finally {
        update(key, () => ({ refreshing: false }));
      }
    },
    [attach, find, update],
  );

  const openThread = useCallback(
    (
      surface: ChatSurface,
      next: ChatThread,
      options: { activate?: boolean; follow?: boolean; projectId?: string | null } = {},
    ) => {
      const existing = tabsRef.current.find((tab) => tab.thread?.id === next.id);
      const inferred = next.projectId === undefined ? projectForCwd(next.cwd) : next.projectId;
      const loaded = {
        projectId:
          options.projectId !== undefined
            ? options.projectId
            : existing && existing.projectId !== undefined
              ? existing.projectId
              : (inferred ?? undefined),
        thread: next,
        messages: next.messages,
        config: next.config,
        historyBefore: next.historyBefore ?? null,
        loadingHistory: false,
        error: null,
      };
      let key: string;
      if (existing) {
        key = existing.key;
        if (!existing.streaming) update(key, () => loaded);
        else if (options.projectId !== undefined)
          update(key, () => ({ projectId: options.projectId }));
      } else {
        const active = find(activeKeysRef.current[surface]);
        if (
          active &&
          isBlank(active) &&
          options.activate !== false &&
          !isActiveElsewhere(surface, active.key)
        ) {
          key = active.key;
          update(key, () => loaded);
        } else {
          const tab = { ...blankTab(next.config), ...loaded };
          key = tab.key;
          mutate((current) => [...current, tab]);
        }
      }
      if (options.activate !== false) activate(surface, key);
      if (existing?.streaming) return key;
      if (options.follow !== false) void attach(key, next.id);
      return key;
    },
    [activate, attach, isActiveElsewhere, mutate, update, find, projectForCwd],
  );
  const showThread = useCallback(
    async (surface: ChatSurface, id: string, isCurrent?: () => boolean) => {
      const open = tabsRef.current.find((tab) => tab.thread?.id === id);
      if (open) {
        if (!isCurrent || isCurrent()) activate(surface, open.key);
        return;
      }
      const thread = await api.chat.get(id);
      if (isCurrent && !isCurrent()) return;
      openThread(surface, thread);
    },
    [activate, openThread],
  );
  const newTab = useCallback(
    (
      surface: ChatSurface,
      options: { projectId?: string | null; fresh?: boolean; workspace?: ChatWorkspace } = {},
    ) => {
      const projectId =
        options.projectId !== undefined
          ? options.projectId
          : ((options.workspace?.cwd ? projectForCwd(options.workspace.cwd) : null) ??
            creationProject.current);
      const blank =
        !options.fresh &&
        tabsRef.current.find(
          (candidate) => isBlank(candidate) && !isActiveElsewhere(surface, candidate.key),
        );
      if (blank) {
        update(blank.key, () => ({
          config: defaults.current,
          projectId,
          ...(options.workspace ? { workspace: options.workspace } : {}),
          error: null,
        }));
        return activate(surface, blank.key);
      }
      const tab = blankTab(defaults.current, projectId);
      if (options.workspace) tab.workspace = options.workspace;
      mutate((current) => [...current, tab]);
      activate(surface, tab.key);
    },
    [activate, isActiveElsewhere, mutate, update, projectForCwd],
  );
  const startAgentConversation = useCallback(
    (
      surface: ChatSurface,
      agent: string,
      providerId?: string,
      model = "",
      options?: ChatAgentOptions,
      permissionMode?: ChatConfig["permissionMode"],
    ) => {
      const agentOptions = providerId ? {} : { ...defaults.current.agentOptions };
      if (options) agentOptions[agent] = options;
      const next = blankTab(
        {
          ...defaults.current,
          agent,
          providerId,
          model,
          agentOptions,
          ...(permissionMode ? { permissionMode } : {}),
        },
        creationProject.current,
      );
      mutate((current) => [...current, next]);
      activate(surface, next.key);
    },
    [activate, mutate],
  );
  const selectProvider = useCallback(
    (surface: ChatSurface, profile: ProviderProfile) => {
      const current = find(activeKeysRef.current[surface]);
      if (!current) return;
      const next = providerSelection(current.config, current.providerDrafts, profile);
      update(current.key, () => next);
      savePreferences(next.config);
    },
    [find, update],
  );
  const closeTab = useCallback(
    (key: string) => {
      update(key, () => ({ hidden: true, queuePaused: true }));
      for (const surface of ["page", "side"] as const) {
        if (activeKeysRef.current[surface] !== key) continue;
        const next = tabsRef.current.find(
          (tab) => !tab.hidden && (!isBlank(tab) || !isActiveElsewhere(surface, tab.key)),
        );
        if (next) activate(surface, next.key);
        else {
          const blank = blankTab(defaults.current, creationProject.current);
          mutate((current) => [...current, blank]);
          activate(surface, blank.key);
        }
      }
    },
    [activate, isActiveElsewhere, mutate, update],
  );

  const initialLinks = useRef(initialChatSurfaceLinks(pathname, search, desktopViewport));
  useEffect(() => {
    const stored = parseChatTabs(readStorage(CHAT_TABS_KEY));
    const restoreSideId =
      stored.sideActive !== undefined
        ? stored.sideActive
        : !initialLinks.current.pageShown && initialLinks.current.sideShown
          ? stored.active
          : null;
    void Promise.allSettled(stored.threads.map((id) => api.chat.get(id))).then((results) => {
      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        const activatePage = !initialLinks.current.pageLinked && result.value.id === stored.active;
        const activateSide = !initialLinks.current.sideLinked && result.value.id === restoreSideId;
        const key = openThread("page", result.value, {
          activate: activatePage,
          projectId: stored.projectIds?.[result.value.id],
        });
        if (activateSide) activate("side", key);
      }
    });
  }, [activate, openThread]);
  useEffect(() => {
    const threads = tabs.flatMap((tab) => (tab.thread && !tab.hidden ? [tab.thread.id] : []));
    const active = tabs.find((tab) => tab.key === activeKeys.page)?.thread?.id ?? null;
    const sideActive = tabs.find((tab) => tab.key === activeKeys.side)?.thread?.id ?? null;
    const projectIds = Object.fromEntries(
      tabs.flatMap((tab) =>
        tab.thread && !tab.hidden && tab.projectId !== undefined
          ? [[tab.thread.id, tab.projectId]]
          : [],
      ),
    );
    writeStorage(
      CHAT_TABS_KEY,
      JSON.stringify({
        threads,
        active,
        sideActive,
        ...(Object.keys(projectIds).length ? { projectIds } : {}),
      }),
    );
  }, [tabs, activeKeys]);

  const tabFor = useCallback(
    (surface: ChatSurface) =>
      tabs.find((candidate) => candidate.key === activeKeys[surface]) ??
      tabs[0] ??
      initials[surface],
    [tabs, activeKeys, initials],
  );

  const setConfig = useCallback(
    (surface: ChatSurface, next: ChatConfig) => {
      update(activeKeysRef.current[surface], () => ({ config: next }));
      savePreferences(next);
    },
    [update],
  );
  const loadOlder = useCallback(
    async (surface: ChatSurface) => {
      const key = activeKeysRef.current[surface];
      const current = find(key);
      if (!current?.thread || current.historyBefore === null || current.loadingHistory) return;
      update(key, () => ({ loadingHistory: true, error: null }));
      try {
        const page = await api.chat.history(current.thread.id, current.historyBefore);
        update(key, (tab) => ({
          historyBefore: page.before,
          messages: [...page.messages, ...tab.messages],
        }));
      } catch (cause) {
        update(key, () => ({ error: message(cause, "Older messages could not be loaded.") }));
      } finally {
        update(key, () => ({ loadingHistory: false }));
      }
    },
    [update, find],
  );

  const releaseQueue = useCallback(
    (key: string) => {
      queueHolds.current.get(key)?.abort();
      const controller = new AbortController();
      queueHolds.current.set(key, controller);
      const signal = controller.signal;
      const owns = () => queueHolds.current.get(key) === controller;
      void (async () => {
        try {
          while (!signal.aborted && owns()) {
            await waitToReconnect(1000, signal, wakeOnConnectivity);
            if (signal.aborted || !owns()) return;
            const tab = find(key);
            if (!tab?.queueHeld || tab.queued.length === 0) return;
            if (tab.queuePaused || tab.streaming || tab.refreshing) continue;
            const threadId = tab.thread?.id;
            if (threadId) {
              try {
                const session = await api.chat.session(threadId);
                if (signal.aborted || !owns()) return;
                if (session.running) continue;
              } catch {
                if (signal.aborted || !owns()) return;
              }
            }
            if (!owns()) return;
            update(key, (current) => (current.queueHeld ? { queueHeld: false } : {}));
            return;
          }
        } finally {
          if (owns()) queueHolds.current.delete(key);
        }
      })();
    },
    [find, update],
  );

  const sendQueued = useCallback(
    async (key: string, userMessage: ChatMessage) => {
      const current = find(key);
      if (
        !ready ||
        !current ||
        current.streaming ||
        current.refreshing ||
        current.queuePaused ||
        current.queueHeld ||
        current.editingQueuedId ||
        current.error ||
        current.queued[0]?.id !== userMessage.id ||
        streams.current.has(key)
      )
        return;
      const { config, thread } = current;
      const pendingFiles = current.queuedFiles[userMessage.id] ?? [];
      let accepted = false;
      update(key, (tab) => ({
        queued: tab.queued.filter((entry) => entry.id !== userMessage.id),
        messages: [...tab.messages, { ...userMessage, timestamp: Date.now() }],
        streaming: true,
        streamText: "",
        activity: [],
        error: null,
        runId: "",
        assistantId: crypto.randomUUID(),
        interjectionSegments: [],
        respondingAgent: config.agent,
        turn: undefined,
      }));
      const followed = await follow(
        key,
        async (signal) => {
          let workspace = current.workspace;
          if (!thread && !workspace) {
            const ssh = await api.ssh.get();
            const last = folderHistory(ssh.host).last;
            workspace = { host: ssh.host, ...(last ? { cwd: last } : {}), worktree: false };
          }
          if (!thread && workspace?.cwd) rememberFolder(workspace.host ?? null, workspace.cwd);
          const modes = permissionModes(
            thread?.capabilities ??
              (
                await queryClient.fetchQuery({
                  queryKey: ["agent-capabilities", config.agent, thread?.id],
                  queryFn: () => api.chat.capabilities(config.agent, thread?.id),
                  staleTime: 30000,
                })
              ).capabilities,
          );
          const payload = {
            ...(!thread && current.projectId ? { projectId: current.projectId } : {}),
            messages: [{ role: "user", content: userMessage.content }],
            clientMessageId: userMessage.id,
            agent: config.agent,
            providerId: config.providerId,
            model: config.model,
            agentOptions: config.agentOptions,
            // An open conversation keeps its stored choice; only a new one adopts
            // the composer value.
            ...(thread ? {} : { sendWhileRunning: config.sendWhileRunning }),
            ...(config.permissionMode && modes.length
              ? {
                  permissionMode: modes.includes(config.permissionMode)
                    ? config.permissionMode
                    : "default",
                }
              : {}),
            ...(thread ? { threadId: thread.id } : { workspace }),
            context: { source: "webchat", route: currentRoute() },
          };
          const files = current.queuedFiles[userMessage.id] ?? [];
          let form: FormData | undefined;
          if (files.length) {
            form = new FormData();
            form.set("payload", JSON.stringify(payload));
            for (const file of files) form.append("files", file, file.name);
          }
          return fetch(`${getApiUrl()}/chat/${form ? "uploads" : "stream"}`, {
            method: "POST",
            headers: {
              "X-Orc-Source": "ui",
              ...activeApiHeaders(),
              ...(!form ? { "Content-Type": "application/json" } : {}),
            },
            credentials: "include",
            body: form ?? JSON.stringify(payload),
            signal,
          });
        },
        () => {
          accepted = true;
        },
        thread ? undefined : { messageId: userMessage.id },
      );
      if (followed === "busy") {
        update(key, (tab) => ({
          messages: tab.messages.filter((entry) => entry.id !== userMessage.id),
          queued: tab.queued.some((entry) => entry.id === userMessage.id)
            ? tab.queued
            : [userMessage, ...tab.queued],
          streaming: false,
          streamText: "",
          activity: [],
          error: null,
          queueHeld: true,
          runId: "",
          turn: undefined,
        }));
        releaseQueue(key);
        return;
      }
      const after = find(key);
      // false = the server had no turn; its fresh messages show whether this send was
      // stored. A new chat has no thread to inspect, so an error means the send was lost.
      const lost =
        !accepted &&
        !!after &&
        (after.thread
          ? followed === false
            ? !after.messages.some((entry) => entry.id === userMessage.id)
            : !!after.error
          : !!after.error);
      if (lost) {
        update(key, (tab) => ({
          messages: tab.messages.filter((entry) => entry.id !== userMessage.id),
          queued: tab.queued.some((entry) => entry.id === userMessage.id)
            ? tab.queued
            : [userMessage, ...tab.queued],
          queuePaused: true,
          // A new chat keeps the server's rejection reason but never points at
          // Refresh, which is a no-op without a thread.
          error: after.thread
            ? (tab.error ??
              "Your message didn't reach the agent. It's back in the queue; send it again when ready.")
            : tab.error
              ? `${tab.error} It's back in the queue; send it again when ready.`
              : "Your message didn't reach the agent. It's back in the queue; send it again when ready.",
        }));
        return;
      }
      update(key, (tab) => ({
        queuedFiles: Object.fromEntries(
          Object.entries(tab.queuedFiles).filter(([id]) => id !== userMessage.id),
        ),
        ...(!accepted && pendingFiles.length ? { files: [...pendingFiles, ...tab.files] } : {}),
      }));
    },
    [ready, follow, update, find, releaseQueue, queryClient],
  );
  // Reserve a turn synchronously before opening its stream. Background tabs drain their
  // own queues, and an error or explicit Stop leaves remaining messages pending.
  useEffect(() => {
    if (!ready) return;
    for (const tab of tabs) {
      if (
        tab.queued.length &&
        !tab.streaming &&
        !tab.refreshing &&
        !tab.error &&
        !tab.queuePaused &&
        !tab.queueHeld &&
        !tab.editingQueuedId &&
        !streams.current.has(tab.key)
      ) {
        void sendQueued(tab.key, tab.queued[0]);
      }
    }
  }, [tabs, ready, sendQueued]);

  // Keyed so an awaited steer can queue into the conversation that asked for it,
  // even if another tab became active meanwhile.
  const queueFor = useCallback(
    async (key: string, input: string) => {
      const current = find(key);
      if (!ready || !current || (!input.trim() && !current.files.length)) return;
      const entry: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: input.trim() || "Please inspect the attached files.",
        timestamp: Date.now(),
      };
      update(key, (tab) => ({
        queued: [...tab.queued, entry],
        files: [],
        queuedFiles: { ...tab.queuedFiles, [entry.id]: tab.files },
        // An explicit new send resumes a stopped queue.
        queuePaused: false,
        error: tab.streaming ? tab.error : null,
      }));
    },
    [ready, find, update],
  );
  const send = useCallback(
    (surface: ChatSurface, input: string) => queueFor(activeKeysRef.current[surface], input),
    [queueFor],
  );

  const stop = useCallback(
    (key: string) => {
      const current = find(key);
      const stream = streams.current.get(key);
      if (!current?.streaming) return;
      if (!current.runId) {
        if (stream) stream.cancel = true;
        return;
      }
      void api.chat.cancel(current.runId).catch((cause) => {
        if (!(cause instanceof ApiError && cause.status === 409))
          update(key, () => ({
            queuePaused: true,
            error: message(cause, "The response could not be stopped."),
          }));
      });
    },
    [update, find],
  );

  const cancel = useCallback(
    (surface: ChatSurface) => {
      const key = activeKeysRef.current[surface];
      update(key, () => ({ queuePaused: true }));
      stop(key);
    },
    [stop, update],
  );

  const setChildWork = useCallback(
    (surface: ChatSurface, workingChildren: number, waitingChildren: number) =>
      update(activeKeysRef.current[surface], (current) =>
        current.workingChildren === workingChildren && current.waitingChildren === waitingChildren
          ? {}
          : { workingChildren, waitingChildren },
      ),
    [update],
  );

  const editQueued = useCallback(
    (surface: ChatSurface, id: string | null, content?: string) => {
      const key = activeKeysRef.current[surface];
      update(key, (tab) => {
        if (id && !tab.queued.some((entry) => entry.id === id)) return {};
        if (content !== undefined && !content.trim()) return {};
        return {
          editingQueuedId: content === undefined ? id : null,
          queuedDraft:
            content === undefined
              ? (tab.queued.find((entry) => entry.id === id)?.content ?? "")
              : "",
          queued:
            content === undefined
              ? tab.queued
              : tab.queued.map((entry) =>
                  entry.id === id ? { ...entry, content: content.trim() } : entry,
                ),
        };
      });
    },
    [update],
  );

  const setDraft = useCallback(
    (surface: ChatSurface, next: string | ((current: string) => string)) =>
      update(activeKeysRef.current[surface], (tab) => {
        const draft = typeof next === "function" ? next(tab.draft) : next;
        return {
          draft,
          ...(!tab.thread && !tab.draft.trim() && draft.trim() ? { createdAt: Date.now() } : {}),
        };
      }),
    [update],
  );
  const removeQueued = useCallback(
    (surface: ChatSurface, id: string) =>
      update(activeKeysRef.current[surface], (tab) => ({
        queued: tab.queued.filter((entry) => entry.id !== id),
        queueHeld: tab.queued.some((entry) => entry.id !== id) && tab.queueHeld,
        queuedFiles: Object.fromEntries(
          Object.entries(tab.queuedFiles).filter(([key]) => key !== id),
        ),
        ...(tab.editingQueuedId === id ? { editingQueuedId: null, queuedDraft: "" } : {}),
      })),
    [update],
  );
  const setQueuedDraft = useCallback(
    (surface: ChatSurface, queuedDraft: string) =>
      update(activeKeysRef.current[surface], () => ({ queuedDraft })),
    [update],
  );

  const forceQueued = useCallback(
    (surface: ChatSurface, id: string) => {
      const key = activeKeysRef.current[surface];
      const tab = find(key);
      const entry = tab?.queued.find((entry) => entry.id === id);
      if (!tab || !entry || tab.refreshing || tab.editingQueuedId) return;
      queueHolds.current.get(key)?.abort();
      update(key, () => ({
        queued: [entry, ...tab.queued.filter((item) => item.id !== id)],
        queuePaused: false,
        queueHeld: false,
        error: null,
      }));
      stop(key);
    },
    [find, stop, update],
  );
  const moveQueued = useCallback(
    (surface: ChatSurface, id: string, direction: -1 | 1) => {
      update(activeKeysRef.current[surface], (tab) => {
        const index = tab.queued.findIndex((entry) => entry.id === id);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= tab.queued.length) return {};
        const queued = [...tab.queued];
        const moved = queued[index];
        if (!moved) return {};
        queued.splice(index, 1);
        queued.splice(target, 0, moved);
        return { queued };
      });
    },
    [update],
  );

  const steeringRequest = useRef<{
    key: string;
    runId: string;
    input: string;
    requestId: string;
  } | null>(null);
  // "unavailable" means the turn cannot take the message now (no live run in this
  // API, capability withdrawn, steering limit). It is not a failure: the caller
  // queues the message instead of asking the user to fix something.
  const steerInput = useCallback(
    async (key: string, input: string): Promise<"steered" | "unavailable" | "failed"> => {
      const current = find(key);
      if (!current?.streaming || !current.runId || !input.trim() || current.files.length)
        return "unavailable";
      setResponding(true);
      try {
        const previous = steeringRequest.current;
        const requestId =
          previous?.key === key && previous.runId === current.runId && previous.input === input
            ? previous.requestId
            : crypto.randomUUID();
        steeringRequest.current = { key, runId: current.runId, input, requestId };
        const runId = current.runId;
        const thread = await api.chat.steer(runId, input, requestId);
        steeringRequest.current = null;
        const delivered = thread.messages.find((message) => message.id === requestId) ?? {
          id: requestId,
          role: "user" as const,
          content: input,
          timestamp: Date.now(),
        };
        const tab = find(key);
        if (tab?.thread?.id === thread.id && tab.runId === runId && tab.streaming)
          update(key, (fresh) => {
            const change = withInterjection(fresh, delivered);
            return {
              thread,
              error: null,
              draft: fresh.draft === input ? "" : fresh.draft,
              ...change,
              ...(change.sealedId
                ? { interjectionSegments: [...fresh.interjectionSegments, change.sealedId] }
                : {}),
            };
          });
        else {
          // The turn ended (or another started) while delivery was in flight: the
          // stored thread owns the order now, and splitting the live buffer would
          // misplace the message. Reconcile from storage instead.
          update(key, (fresh) => ({
            error: null,
            draft: fresh.draft === input ? "" : fresh.draft,
          }));
          void syncThread(key);
        }
        return "steered";
      } catch (cause) {
        // A plain conflict means the turn cannot take the message: queueing is safe.
        // An unconfirmed steer may already be in the conversation, so resending it
        // would duplicate both the text and the turn. A refused steer's local split
        // (the dispatch event arrived before the refusal) reconciles at turn end.
        if (cause instanceof ApiError && cause.status === 409 && cause.code !== STEER_UNCONFIRMED)
          return "unavailable";
        update(key, () => ({
          error: message(cause, "The message could not be sent into the active response."),
        }));
        return "failed";
      } finally {
        setResponding(false);
      }
    },
    [find, update, syncThread],
  );
  const deliver = useCallback(
    async (surface: ChatSurface, input: string): Promise<"steered" | "queued" | "failed"> => {
      const key = activeKeysRef.current[surface];
      const current = find(key);
      if (!ready || !current) return "failed";
      if (steersLive(current)) {
        const outcome = await steerInput(key, input);
        if (outcome !== "unavailable") return outcome;
      }
      await queueFor(key, input);
      return "queued";
    },
    [find, queueFor, ready, steerInput],
  );
  const steer = useCallback(
    async (surface: ChatSurface) => {
      const key = activeKeysRef.current[surface];
      const current = find(key);
      if (
        !current?.streaming ||
        !current.runId ||
        !current.draft.trim() ||
        current.files.length ||
        responding
      )
        return;
      const input = current.draft;
      const outcome = await steerInput(key, input);
      if (outcome === "unavailable") await queueFor(key, input);
      if (outcome !== "failed")
        update(key, (tab) => ({ draft: tab.draft === input ? "" : tab.draft }));
    },
    [find, queueFor, responding, steerInput, update],
  );

  const respondPermission = useCallback(
    async (
      surface: ChatSurface,
      decision: "approved" | "session" | "denied",
      feedback?: string,
    ) => {
      const key = activeKeysRef.current[surface];
      const current = find(key);
      const pending = current?.permissions[0];
      if (!current || !pending || responding) return;
      setResponding(true);
      try {
        await api.chat.permission(current.runId, pending.requestId, decision, feedback);
        update(key, (tab) => ({
          permissions: tab.permissions.filter((request) => request.requestId !== pending.requestId),
        }));
      } catch (cause) {
        update(key, () => ({ error: message(cause, "Permission could not be sent.") }));
      } finally {
        setResponding(false);
      }
    },
    [responding, update, find],
  );
  const respondQuestion = useCallback(
    async (surface: ChatSurface, answers: Record<string, string[]>) => {
      const key = activeKeysRef.current[surface];
      const current = find(key);
      const pending = current?.questions[0];
      if (!current || !pending || responding) return;
      setResponding(true);
      try {
        const runId = current.runId;
        const { message: recorded } = await api.chat.answer(runId, pending.requestId, answers);
        const tab = find(key);
        const live = tab?.runId === runId && tab.streaming;
        update(key, (fresh) => {
          const change: Partial<InterjectionChange> = live ? withInterjection(fresh, recorded) : {};
          return {
            questions: fresh.questions.filter((request) => request.requestId !== pending.requestId),
            ...change,
            ...(change.sealedId
              ? { interjectionSegments: [...fresh.interjectionSegments, change.sealedId] }
              : {}),
          };
        });
        if (!live) void syncThread(key);
      } catch (cause) {
        update(key, () => ({ error: message(cause, "Answer could not be sent.") }));
      } finally {
        setResponding(false);
      }
    },
    [responding, update, find, syncThread],
  );
  const changePermissions = useCallback(
    async (surface: ChatSurface, next: ChatConfig) => {
      const key = activeKeysRef.current[surface];
      setConfig(surface, next);
      const current = find(key);
      const mode = next.permissionMode;
      if (!mode || !current?.streaming || !current.runId) return;
      try {
        const updated = await api.chat.permissionMode(current.runId, mode);
        update(key, (tab) =>
          tab.thread?.id === updated.id
            ? {
                thread: updated,
                config: {
                  ...tab.config,
                  permissionMode: updated.config.permissionMode,
                  agentOptions: updated.config.agentOptions,
                },
              }
            : {},
        );
      } catch (cause) {
        update(key, () => ({ error: message(cause, "Permissions could not be changed.") }));
      }
    },
    [setConfig, update, find],
  );
  const changeSendMode = useCallback(
    async (surface: ChatSurface, sendWhileRunning: ChatConfig["sendWhileRunning"]) => {
      const key = activeKeysRef.current[surface];
      const current = find(key);
      if (!current) return;
      const previous = current.config.sendWhileRunning;
      update(key, (tab) => ({ config: { ...tab.config, sendWhileRunning } }));
      if (!current.thread) return;
      try {
        const updated = await api.chat.configure(current.thread.id, { sendWhileRunning });
        update(key, (tab) => (tab.thread?.id === updated.id ? { thread: updated } : {}));
      } catch (cause) {
        update(key, (tab) => ({
          config: { ...tab.config, sendWhileRunning: previous },
          error: message(cause, "The send preference could not be saved."),
        }));
      }
    },
    [find, update],
  );
  const applyAgentOptions = useCallback(
    async (surface: ChatSurface, agent: string, options: ChatAgentOptions) => {
      const key = activeKeysRef.current[surface];
      const current = find(key);
      if (!current) return false;
      const agentOptions = { ...current.config.agentOptions, [agent]: options };
      if (current.thread) await api.chat.configure(current.thread.id, { agentOptions });
      update(key, (tab) =>
        tab.config.agent === agent
          ? {
              config: {
                ...tab.config,
                agentOptions: { ...tab.config.agentOptions, [agent]: options },
              },
            }
          : {},
      );
      return true;
    },
    [update, find],
  );
  const addFiles = useCallback(
    (surface: ChatSurface, files: File[]) =>
      update(activeKeysRef.current[surface], (current) => {
        const next = [...new Set([...current.files, ...files])];
        if (
          next.length > UPLOAD_MAX_FILES ||
          next.reduce((sum, file) => sum + file.size, 0) > UPLOAD_MAX_BYTES
        )
          return { error: "Attach at most 10 files, totaling at most 20 MB" };
        return { files: next, error: null };
      }),
    [update],
  );
  const removeFile = useCallback(
    (surface: ChatSurface, index: number) =>
      update(activeKeysRef.current[surface], (current) => ({
        files: current.files.filter((_, candidate) => candidate !== index),
      })),
    [update],
  );
  const setWorkspace = useCallback(
    (surface: ChatSurface, workspace: ChatWorkspace) =>
      update(activeKeysRef.current[surface], (current) =>
        current.thread || current.streaming
          ? {}
          : {
              workspace,
              ...(workspace.cwd
                ? { projectId: workspace.host ? null : projectForCwd(workspace.cwd) }
                : {}),
            },
      ),
    [projectForCwd, update],
  );

  return {
    projectScope: selectedProject ?? "all",
    tabs,
    activeKeys,
    tabFor,
    handoff,
    selectTab: activate,
    closeTab,
    newTab,
    startAgentConversation,
    selectProvider,
    showThread,
    addFiles,
    removeFile,
    setDraft,
    setQueuedDraft,
    editQueued,
    removeQueued,
    moveQueued,
    forceQueued,
    refresh,
    setChildWork,
    setWorkspace,
    setConfig,
    changePermissions,
    changeSendMode,
    applyAgentOptions,
    ready,
    openThread,
    loadOlder,
    steer,
    respondPermission,
    respondQuestion,
    responding,
    send,
    deliver,
    cancel,
  };
}

type ChatStore = ReturnType<typeof useChatStore>;

function useChatSurfaceController(store: ChatStore, surface: ChatSurface) {
  const tab = store.tabFor(surface);
  const activeKey = tab.key;
  const workspacePickerSession = useFolderPickerSession();
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const pickerConversation = useRef(activeKey);
  useEffect(() => {
    if (pickerConversation.current === activeKey) return;
    pickerConversation.current = activeKey;
    setWorkspacePickerOpen(false);
    workspacePickerSession.reset("");
  }, [activeKey, workspacePickerSession.reset]);

  const selectTab = useCallback(
    (key: string) => store.selectTab(surface, key),
    [store.selectTab, surface],
  );
  const newTab = useCallback(
    (options?: { projectId?: string | null; fresh?: boolean; workspace?: ChatWorkspace }) =>
      store.newTab(surface, options),
    [store.newTab, surface],
  );
  const startAgentConversation = useCallback(
    (
      agent: string,
      providerId?: string,
      model?: string,
      options?: ChatAgentOptions,
      permissionMode?: ChatConfig["permissionMode"],
    ) => store.startAgentConversation(surface, agent, providerId, model, options, permissionMode),
    [store.startAgentConversation, surface],
  );
  const selectProvider = useCallback(
    (profile: ProviderProfile) => store.selectProvider(surface, profile),
    [store.selectProvider, surface],
  );
  const showThread = useCallback(
    (id: string) => store.showThread(surface, id),
    [store.showThread, surface],
  );
  const openThread = useCallback(
    (
      next: ChatThread,
      options?: { activate?: boolean; follow?: boolean; projectId?: string | null },
    ) => store.openThread(surface, next, options),
    [store.openThread, surface],
  );
  const addFiles = useCallback(
    (files: File[]) => store.addFiles(surface, files),
    [store.addFiles, surface],
  );
  const removeFile = useCallback(
    (index: number) => store.removeFile(surface, index),
    [store.removeFile, surface],
  );
  const setDraft = useCallback(
    (next: string | ((current: string) => string)) => store.setDraft(surface, next),
    [store.setDraft, surface],
  );
  const setQueuedDraft = useCallback(
    (queuedDraft: string) => store.setQueuedDraft(surface, queuedDraft),
    [store.setQueuedDraft, surface],
  );
  const editQueued = useCallback(
    (id: string | null, content?: string) => store.editQueued(surface, id, content),
    [store.editQueued, surface],
  );
  const removeQueued = useCallback(
    (id: string) => store.removeQueued(surface, id),
    [store.removeQueued, surface],
  );
  const moveQueued = useCallback(
    (id: string, direction: -1 | 1) => store.moveQueued(surface, id, direction),
    [store.moveQueued, surface],
  );
  const forceQueued = useCallback(
    (id: string) => store.forceQueued(surface, id),
    [store.forceQueued, surface],
  );
  const refresh = useCallback(
    (rebuild?: boolean) => store.refresh(surface, rebuild),
    [store.refresh, surface],
  );
  const setChildWork = useCallback(
    (workingChildren: number, waitingChildren: number) =>
      store.setChildWork(surface, workingChildren, waitingChildren),
    [store.setChildWork, surface],
  );
  const openWorkspacePicker = useCallback(
    (initial: string) => {
      workspacePickerSession.reset(initial);
      setWorkspacePickerOpen(true);
    },
    [workspacePickerSession.reset],
  );
  const setWorkspace = useCallback(
    (workspace: ChatWorkspace) => store.setWorkspace(surface, workspace),
    [store.setWorkspace, surface],
  );
  const setConfig = useCallback(
    (next: ChatConfig) => store.setConfig(surface, next),
    [store.setConfig, surface],
  );
  const changePermissions = useCallback(
    (next: ChatConfig) => store.changePermissions(surface, next),
    [store.changePermissions, surface],
  );
  const changeSendMode = useCallback(
    (sendWhileRunning: ChatConfig["sendWhileRunning"]) =>
      store.changeSendMode(surface, sendWhileRunning),
    [store.changeSendMode, surface],
  );
  const applyAgentOptions = useCallback(
    (agent: string, options: ChatAgentOptions) => store.applyAgentOptions(surface, agent, options),
    [store.applyAgentOptions, surface],
  );
  const loadOlder = useCallback(() => store.loadOlder(surface), [store.loadOlder, surface]);
  const steer = useCallback(() => store.steer(surface), [store.steer, surface]);
  const respondPermission = useCallback(
    (decision: "approved" | "session" | "denied", feedback?: string) =>
      store.respondPermission(surface, decision, feedback),
    [store.respondPermission, surface],
  );
  const respondQuestion = useCallback(
    (answers: Record<string, string[]>) => store.respondQuestion(surface, answers),
    [store.respondQuestion, surface],
  );
  const send = useCallback((input: string) => store.send(surface, input), [store.send, surface]);
  const deliver = useCallback(
    (input: string) => store.deliver(surface, input),
    [store.deliver, surface],
  );
  const cancel = useCallback(() => store.cancel(surface), [store.cancel, surface]);

  return {
    surface,
    projectScope: store.projectScope,
    projectId: tab.projectId ?? null,
    tabs: store.tabs,
    activeKey,
    selectTab,
    closeTab: store.closeTab,
    newTab,
    startAgentConversation,
    selectProvider,
    showThread,
    messages: tab.messages,
    draft: tab.draft,
    files: tab.files,
    addFiles,
    removeFile,
    setDraft,
    queued: tab.queued,
    queuePaused: tab.queuePaused,
    editingQueuedId: tab.editingQueuedId,
    queuedDraft: tab.queuedDraft,
    setQueuedDraft,
    editQueued,
    removeQueued,
    moveQueued,
    forceQueued,
    streaming: tab.streaming,
    reconnecting: tab.reconnecting,
    refreshing: tab.refreshing,
    refresh,
    setChildWork,
    streamText: tab.streamText,
    activity: tab.activity,
    error: tab.error,
    workspace: tab.workspace,
    workspacePickerSession,
    workspacePickerOpen,
    setWorkspacePickerOpen,
    openWorkspacePicker,
    setWorkspace,
    config: tab.config,
    setConfig,
    changePermissions,
    changeSendMode,
    canSteerLive: steersLive(tab),
    steerAvailable: canSteer(tab),
    applyAgentOptions,
    ready: store.ready,
    thread: tab.thread,
    openThread,
    historyBefore: tab.historyBefore,
    loadingHistory: tab.loadingHistory,
    loadOlder,
    permission: tab.permissions[0] ?? null,
    steer,
    respondPermission,
    question: tab.questions[0] ?? null,
    respondQuestion,
    responding: store.responding,
    send,
    deliver,
    cancel,
    streamingId: tab.assistantId,
    streamingAgent: tab.respondingAgent,
    turn: tab.turn,
  };
}

type ChatController = ReturnType<typeof useChatSurfaceController>;

const ChatStoreContext = createContext<ChatStore | null>(null);
const ChatContext = createContext<ChatController | null>(null);
const ChatPageContext = createContext<ChatController | null>(null);
const ChatSideContext = createContext<ChatController | null>(null);

function useChatLinks(store: ChatStore, desktopViewport: boolean) {
  const [params, setParams] = useSearchParams();
  const { pathname, search } = useLocation();
  const links = chatSurfaceLinks(pathname, search, desktopViewport);
  const hasLiveLink = params.has(SESSION_LIVE_PARAM);
  const loadingPage = useRef<string | null>(null);
  const loadingSide = useRef<string | null>(null);
  const [settled, setSettled] = useState(0);
  const { showThread } = store;
  const pageCurrent = store.tabFor("page").thread?.id ?? null;
  const sideCurrent = store.tabFor("side").thread?.id ?? null;

  useEffect(() => {
    const target = links.pageLinked;
    if (links.redirecting || !target || target === loadingPage.current) return;
    let active = true;
    loadingPage.current = target;
    showThread("page", target, () => active && loadingPage.current === target)
      .catch(() => {})
      .finally(() => {
        if (!active || loadingPage.current !== target) return;
        loadingPage.current = null;
        setSettled((count) => count + 1);
      });
    return () => {
      active = false;
      if (loadingPage.current === target) loadingPage.current = null;
    };
  }, [links.redirecting, links.pageLinked, showThread]);

  useEffect(() => {
    const target = links.sideLinked;
    if (links.redirecting || !target || target === loadingSide.current) return;
    let active = true;
    loadingSide.current = target;
    showThread("side", target, () => active && loadingSide.current === target)
      .catch(() => {})
      .finally(() => {
        if (!active || loadingSide.current !== target) return;
        loadingSide.current = null;
        setSettled((count) => count + 1);
      });
    return () => {
      active = false;
      if (loadingSide.current === target) loadingSide.current = null;
    };
  }, [links.redirecting, links.sideLinked, showThread]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: settled triggers re-sync once a link load finishes
  useEffect(() => {
    if (links.redirecting) return;
    const current = new URLSearchParams(window.location.search);
    const next = new URLSearchParams(current);
    if (
      links.pageShown &&
      links.pageParam &&
      !loadingPage.current &&
      !hasLiveLink &&
      pageCurrent !== links.pageLinked
    ) {
      if (pageCurrent) next.set(links.pageParam, pageCurrent);
      else next.delete(links.pageParam);
    }
    if (
      links.sideShown &&
      links.sideParam &&
      !loadingSide.current &&
      sideCurrent !== links.sideLinked
    ) {
      if (sideCurrent) next.set(links.sideParam, sideCurrent);
      else next.delete(links.sideParam);
    }
    if (next.toString() !== current.toString()) setParams(next, { replace: true });
  }, [
    links.redirecting,
    links.pageShown,
    links.pageParam,
    links.pageLinked,
    links.sideShown,
    links.sideParam,
    links.sideLinked,
    hasLiveLink,
    pageCurrent,
    sideCurrent,
    setParams,
    settled,
  ]);
}

const threadMessages = new WeakMap<ChatMessage, ThreadMessageLike>();
function toThreadMessage(message: ChatMessage): ThreadMessageLike {
  let converted = threadMessages.get(message);
  if (!converted) {
    converted = {
      id: message.id,
      role: message.role,
      content: [{ type: "text", text: message.content }],
      createdAt: new Date(message.timestamp),
      metadata: {
        custom: {
          agent: message.agent,
          activity: message.activity,
          providerActivity: message.providerActivity,
          attachments: message.attachments,
          deliveries: message.deliveries,
          content: message.content,
          turn: message.turn,
        },
      },
    };
    threadMessages.set(message, converted);
  }
  return converted;
}
const asThreadMessage = (message: ThreadMessageLike) => message;

function useSurfaceRuntime(chat: ChatController) {
  const messages = useMemo<ThreadMessageLike[]>(() => {
    const history = groupChatMessages(chat.messages).messages.map(toThreadMessage);
    if (chat.streaming)
      history.push({
        id: chat.streamingId,
        role: "assistant",
        content: [{ type: "text", text: chat.streamText }],
        status: { type: "running" },
        metadata: {
          custom: {
            agent: chat.streamingAgent,
            activity: chat.activity,
            turn: chat.turn,
            live: true,
          },
        },
      });
    return history;
  }, [
    chat.messages,
    chat.streaming,
    chat.streamingId,
    chat.streamingAgent,
    chat.streamText,
    chat.activity,
    chat.turn,
  ]);
  return useExternalStoreRuntime({
    messages,
    convertMessage: asThreadMessage,
    isRunning: chat.streaming,
    onNew: async (message: AppendMessage) => {
      await chat.send(
        message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
      );
    },
    onCancel: async () => chat.cancel(),
  });
}

export function ChatProvider({
  children,
  desktopViewport: desktopOverride,
}: {
  children: ReactNode;
  desktopViewport?: boolean;
}) {
  const detectedDesktop = useBreakpoint("xl");
  const desktopViewport = desktopOverride ?? detectedDesktop;
  const store = useChatStore(desktopViewport);
  useChatLinks(store, desktopViewport);
  const page = useChatSurfaceController(store, "page");
  const side = useChatSurfaceController(store, "side");
  return createElement(
    ChatStoreContext.Provider,
    { value: store },
    createElement(
      ChatPageContext.Provider,
      { value: page },
      createElement(
        ChatSideContext.Provider,
        { value: side },
        createElement(ChatContext.Provider, { value: page }, children),
      ),
    ),
  );
}

export function ChatSurfaceProvider({
  surface,
  children,
}: {
  surface: ChatSurface;
  children: ReactNode;
}) {
  const page = useContext(ChatPageContext);
  const side = useContext(ChatSideContext);
  const chat = surface === "side" ? side : page;
  if (!chat) throw new Error("ChatSurfaceProvider must be used inside ChatProvider");
  const runtime = useSurfaceRuntime(chat);
  return createElement(
    ChatContext.Provider,
    { value: chat },
    createElement(AssistantRuntimeProvider, { runtime }, children),
  );
}

export function useChat(surface?: ChatSurface) {
  const current = useContext(ChatContext);
  const page = useContext(ChatPageContext);
  const side = useContext(ChatSideContext);
  if (!current || !page || !side) throw new Error("useChat must be used inside ChatProvider");
  if (surface === "side") return side;
  if (surface === "page") return page;
  return current;
}

export function useChatSurfaces() {
  const store = useContext(ChatStoreContext);
  if (!store) throw new Error("useChatSurfaces must be used inside ChatProvider");
  return {
    projectScope: store.projectScope,
    tabs: store.tabs,
    activeKeys: store.activeKeys,
    page: store.tabFor("page"),
    side: store.tabFor("side"),
    handoff: store.handoff,
  };
}
