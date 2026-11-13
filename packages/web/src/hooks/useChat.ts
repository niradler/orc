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
} from "@orc/core/chat";
import type { ChatAgentOptions } from "@orc/core/chat-options";
import type { ProviderProfile } from "@orc/core/providers";
import { UPLOAD_MAX_BYTES, UPLOAD_MAX_FILES } from "@orc/core/session-file-types";
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
import { API_ACCESS_CHANGED } from "@/lib/api-credentials";
import { folderHistory, rememberFolder } from "@/lib/folder-history";
import { reconnectDelay, waitToReconnect } from "@/lib/reconnect";
import { getResourceConnection, subscribeResourceConnection } from "@/lib/resource-events";
import {
  CHAT_PREFERENCES_KEY,
  CHAT_TABS_KEY,
  type ChatConfig,
  DEFAULT_CONFIG,
  isChatThreadId,
  parseChatEvent,
  parseChatPreferences,
  parseChatTabs,
  withPreferences,
} from "./chat-contract";
import { type ProviderDrafts, providerSelection } from "./chat-provider-config";

export type { ChatMessage } from "@orc/core/chat";

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

/** URL parameter naming the open conversation, so a chat link can be shared. */
export const CHAT_THREAD_PARAM = "chatThread";

/** The dashboard page the user is chatting from, without the chat's own URL state. */
export function currentRoute(): string {
  const params = new URLSearchParams(window.location.search);
  params.delete("chat");
  params.delete(CHAT_THREAD_PARAM);
  const query = params.toString();
  const route = `${window.location.pathname}${query ? `?${query}` : ""}`;
  // The server caps the route; a page path alone still says where the user is.
  return route.length <= 2000 ? route : window.location.pathname.slice(0, 2000);
}

interface PendingPermission {
  requestId: string;
  tool: string;
  command: string;
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
  respondingAgent: string;
  /** A background turn finished or is waiting for a reply since the tab was last viewed. */
  attention: boolean;
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
  return cause instanceof ApiError && cause.status === 409 && BUSY_CONFLICTS.has(cause.message);
}

function useChatController() {
  const [params] = useSearchParams();
  const selectedProject = params.get("project") ?? readStorage("orc_selected_project");
  const creationProject = useRef<string | null | undefined>(undefined);
  creationProject.current =
    selectedProject === "unassigned"
      ? null
      : selectedProject && selectedProject !== "all"
        ? selectedProject
        : undefined;
  const [initial] = useState(() =>
    blankTab(
      withPreferences(DEFAULT_CONFIG, parseChatPreferences(readStorage(CHAT_PREFERENCES_KEY))),
      creationProject.current,
    ),
  );
  const [tabs, setTabs] = useState<ChatTab[]>([initial]);
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
  const [activeKey, setActiveKey] = useState(initial.key);
  const workspacePickerSession = useFolderPickerSession();
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const pickerConversation = useRef(activeKey);
  useEffect(() => {
    if (pickerConversation.current === activeKey) return;
    pickerConversation.current = activeKey;
    setWorkspacePickerOpen(false);
    workspacePickerSession.reset("");
  }, [activeKey, workspacePickerSession.reset]);
  const [ready, setReady] = useState(false);
  const [responding, setResponding] = useState(false);
  // Refs hold the latest tabs synchronously, so concurrent streams never update stale copies.
  const tabsRef = useRef(tabs);
  const activeRef = useRef(activeKey);
  // `cancel` waits for the server to name the run; `closed` marks a tab that is gone but
  // whose stream is kept open only so that pending cancel can still be sent.
  const streams = useRef(
    new Map<string, { controller: AbortController; cancel: boolean; closed: boolean }>(),
  );
  const queueHolds = useRef(new Map<string, AbortController>());
  const defaults = useRef(initial.config);

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
    (key: string) => {
      activeRef.current = key;
      setActiveKey(key);
      update(key, () => ({ attention: false, hidden: false }));
    },
    [update],
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
      update(activeRef.current, () => ({
        error: message(cause, "Chat settings could not be loaded."),
      }));
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
      const background = key !== activeRef.current;
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
      else if (event.type === "text")
        update(key, (tab) => ({ streamText: tab.streamText + event.text }));
      else if (event.type === "narration")
        update(key, (tab) => ({
          streamText: "",
          activity: appendChatActivity(tab.activity, event),
        }));
      else if (event.type === "error") update(key, () => ({ error: event.message }));
      else if (event.type === "session")
        update(key, (tab) => ({
          thread: tab.thread ? { ...tab.thread, runtimeId: event.runtimeId } : tab.thread,
        }));
      else if (event.type === "permission_request")
        update(key, (tab) => ({
          permissions: [...tab.permissions, event.data],
          attention: tab.attention || background,
        }));
      else if (event.type === "question_request")
        update(key, (tab) => ({
          questions: [...tab.questions, event.data],
          attention: tab.attention || background,
        }));
      else if (event.type === "request_resolved")
        update(key, (tab) => ({
          permissions: tab.permissions.filter((request) => request.requestId !== event.requestId),
          questions: tab.questions.filter((request) => request.requestId !== event.requestId),
        }));
      else if (event.type !== "done")
        update(key, (tab) => ({ activity: appendChatActivity(tab.activity, event) }));
    },
    [update],
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
        turn: undefined,
        permissions: [],
        questions: [],
        attention: tab.attention || (tab.streaming && key !== activeRef.current),
      })),
    [update],
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
              messages: fresh.messages,
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
                const fresh = await api.chat.get(threadId);
                if (current())
                  update(key, () => ({
                    thread: fresh,
                    messages: fresh.messages,
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
                error: null,
              }));
              onOpen?.();
              retried = true;
              connect = (signal) =>
                fetch(`${getApiUrl()}/chat/threads/${encodeURIComponent(adopted.id)}/live`, {
                  credentials: "include",
                  signal,
                });
              continue;
            }
            if (cause instanceof ApiError && cause.status < 500) throw cause;
            retried = true;
            failures++;
            update(key, () => ({ reconnecting: true }));
            // Never repeat POST /chat/stream: it may already have started a turn.
            connect = (signal) =>
              fetch(`${getApiUrl()}/chat/threads/${encodeURIComponent(threadId)}/live`, {
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
            credentials: "include",
            signal,
          }),
        () =>
          update(key, (tab) => ({
            streaming: true,
            assistantId: crypto.randomUUID(),
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
    async (rebuild = false) => {
      const key = activeRef.current;
      const tab = find(key);
      if (!tab?.thread || tab.refreshing) return;
      update(key, () => ({ refreshing: true, error: null }));
      try {
        const fresh = await (rebuild ? api.chat.refresh : api.chat.get)(tab.thread.id);
        if (!find(key)) return;
        // Detach only this browser's reader; the server keeps the existing turn alive.
        const previous = streams.current.get(key);
        streams.current.delete(key);
        previous?.controller.abort();
        update(key, () => ({
          thread: fresh,
          config: fresh.config,
          messages: fresh.messages,
          historyBefore: fresh.historyBefore ?? null,
          streaming: true,
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
      next: ChatThread,
      options: { activate?: boolean; follow?: boolean; projectId?: string | null } = {},
    ) => {
      const existing = tabsRef.current.find((tab) => tab.thread?.id === next.id);
      const loaded = {
        projectId: options.projectId !== undefined ? options.projectId : existing?.projectId,
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
        const active = find(activeRef.current);
        if (active && isBlank(active) && options.activate !== false) {
          key = active.key;
          update(key, () => loaded);
        } else {
          const tab = { ...blankTab(next.config), ...loaded };
          key = tab.key;
          mutate((current) => [...current, tab]);
        }
      }
      if (options.activate !== false) activate(key);
      if (existing?.streaming) return;
      if (options.follow !== false) void attach(key, next.id);
    },
    [activate, attach, mutate, update, find],
  );
  const showThread = useCallback(
    async (id: string) => {
      const open = tabsRef.current.find((tab) => tab.thread?.id === id);
      if (open) return activate(open.key);
      openThread(await api.chat.get(id));
    },
    [activate, openThread],
  );
  const newTab = useCallback(
    (options: { projectId?: string | null; fresh?: boolean; workspace?: ChatWorkspace } = {}) => {
      const projectId =
        options.projectId === undefined ? creationProject.current : options.projectId;
      const blank = !options.fresh && tabsRef.current.find(isBlank);
      if (blank) {
        update(blank.key, () => ({
          config: defaults.current,
          projectId,
          ...(options.workspace ? { workspace: options.workspace } : {}),
          error: null,
        }));
        return activate(blank.key);
      }
      const tab = blankTab(defaults.current, projectId);
      if (options.workspace) tab.workspace = options.workspace;
      mutate((current) => [...current, tab]);
      activate(tab.key);
    },
    [activate, mutate, update],
  );
  const startAgentConversation = useCallback(
    (agent: string, providerId?: string, model = "", options?: ChatAgentOptions) => {
      const agentOptions = providerId ? {} : { ...defaults.current.agentOptions };
      if (options) agentOptions[agent] = options;
      const next = blankTab(
        { ...defaults.current, agent, providerId, model, agentOptions },
        creationProject.current,
      );
      mutate((current) => [...current, next]);
      activate(next.key);
    },
    [activate, mutate],
  );
  const selectProvider = useCallback(
    (profile: ProviderProfile) => {
      const current = find(activeRef.current);
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
      if (activeRef.current !== key) return;
      const next = tabsRef.current.find((tab) => !tab.hidden);
      if (next) activate(next.key);
      else {
        const blank = blankTab(defaults.current, creationProject.current);
        mutate((current) => [...current, blank]);
        activate(blank.key);
      }
    },
    [activate, mutate, update],
  );

  // Reopen this browser's tabs; a shared link's conversation takes focus over the stored one.
  const linked = useRef(params.get(CHAT_THREAD_PARAM));
  useEffect(() => {
    const stored = parseChatTabs(readStorage(CHAT_TABS_KEY));
    void Promise.allSettled(stored.threads.map((id) => api.chat.get(id))).then((results) => {
      for (const result of results)
        if (result.status === "fulfilled")
          openThread(result.value, {
            activate: !linked.current && result.value.id === stored.active,
            projectId: stored.projectIds?.[result.value.id],
          });
    });
  }, [openThread]);
  useEffect(() => {
    const threads = tabs.flatMap((tab) => (tab.thread && !tab.hidden ? [tab.thread.id] : []));
    const active = tabs.find((tab) => tab.key === activeKey)?.thread?.id ?? null;
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
        ...(Object.keys(projectIds).length ? { projectIds } : {}),
      }),
    );
  }, [tabs, activeKey]);

  const tab = tabs.find((candidate) => candidate.key === activeKey) ?? tabs[0] ?? initial;
  const permission = tab.permissions[0] ?? null;
  const question = tab.questions[0] ?? null;

  const setConfig = useCallback(
    (next: ChatConfig) => {
      update(activeRef.current, () => ({ config: next }));
      savePreferences(next);
    },
    [update],
  );
  const loadOlder = useCallback(async () => {
    const key = activeRef.current;
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
  }, [update, find]);

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
          const payload = {
            ...(!thread && current.projectId ? { projectId: current.projectId } : {}),
            messages: [{ role: "user", content: userMessage.content }],
            clientMessageId: userMessage.id,
            agent: config.agent,
            providerId: config.providerId,
            model: config.model,
            agentOptions: config.agentOptions,
            ...(config.permissionMode && ["claude", "codex", "pi"].includes(config.agent)
              ? { permissionMode: config.permissionMode }
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
    [ready, follow, update, find, releaseQueue],
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

  const send = useCallback(
    async (input: string) => {
      const key = activeRef.current;
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

  const cancel = useCallback(() => {
    const key = activeRef.current;
    update(key, () => ({ queuePaused: true }));
    stop(key);
  }, [stop, update]);

  const editQueued = useCallback(
    (id: string | null, content?: string) => {
      const key = activeRef.current;
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
    (draft: string) =>
      update(activeRef.current, (tab) => ({
        draft,
        ...(!tab.thread && !tab.draft.trim() && draft.trim() ? { createdAt: Date.now() } : {}),
      })),
    [update],
  );
  const removeQueued = useCallback(
    (id: string) =>
      update(activeRef.current, (tab) => ({
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
    (queuedDraft: string) => update(activeRef.current, () => ({ queuedDraft })),
    [update],
  );

  const forceQueued = useCallback(
    (id: string) => {
      const key = activeRef.current;
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
    (id: string, direction: -1 | 1) => {
      update(activeRef.current, (tab) => {
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
  const steer = useCallback(async () => {
    const key = activeRef.current;
    const current = find(key);
    if (
      !current?.streaming ||
      !current.runId ||
      !current.draft.trim() ||
      current.files.length ||
      responding
    )
      return;
    setResponding(true);
    try {
      const input = current.draft;
      const previous = steeringRequest.current;
      const requestId =
        previous?.key === key && previous.runId === current.runId && previous.input === input
          ? previous.requestId
          : crypto.randomUUID();
      steeringRequest.current = { key, runId: current.runId, input, requestId };
      const thread = await api.chat.steer(current.runId, input, requestId);
      steeringRequest.current = null;
      const delivered = thread.messages.find((message) => message.id === requestId) ?? {
        id: requestId,
        role: "user" as const,
        content: input,
        timestamp: Date.now(),
      };
      update(key, (tab) => ({
        thread,
        draft: tab.draft === input ? "" : tab.draft,
        messages: tab.messages.some((message) => message.id === requestId)
          ? tab.messages.map((message) => (message.id === requestId ? delivered : message))
          : [...tab.messages, delivered],
      }));
    } catch (cause) {
      update(key, () => ({
        error: message(cause, "The message could not be sent into the active response."),
      }));
    } finally {
      setResponding(false);
    }
  }, [find, update, responding]);

  const respondPermission = useCallback(
    async (decision: "approved" | "denied") => {
      const key = activeRef.current;
      const current = find(key);
      const pending = current?.permissions[0];
      if (!current || !pending || responding) return;
      setResponding(true);
      try {
        await api.chat.permission(current.runId, pending.requestId, decision);
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
    async (answers: Record<string, string[]>) => {
      const key = activeRef.current;
      const current = find(key);
      const pending = current?.questions[0];
      if (!current || !pending || responding) return;
      setResponding(true);
      try {
        await api.chat.answer(current.runId, pending.requestId, answers);
        update(key, (tab) => ({
          questions: tab.questions.filter((request) => request.requestId !== pending.requestId),
        }));
      } catch (cause) {
        update(key, () => ({ error: message(cause, "Answer could not be sent.") }));
      } finally {
        setResponding(false);
      }
    },
    [responding, update, find],
  );
  // While the agent is responding the change goes to the live run, which approves prompts
  // the new mode would not ask for; otherwise it applies to the next message.
  const changePermissions = useCallback(
    async (next: ChatConfig) => {
      const key = activeRef.current;
      setConfig(next);
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
  const applyAgentOptions = useCallback(
    async (agent: string, options: ChatAgentOptions) => {
      const key = activeRef.current;
      const current = find(key);
      if (!current) return false;
      const agentOptions = { ...current.config.agentOptions, [agent]: options };
      if (current.thread) await api.chat.configure(current.thread.id, agentOptions);
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
  return {
    projectScope: selectedProject ?? "all",
    projectId: tab.projectId ?? null,
    tabs,
    activeKey,
    selectTab: activate,
    closeTab,
    newTab,
    startAgentConversation,
    selectProvider,
    showThread,
    messages: tab.messages,
    draft: tab.draft,
    files: tab.files,
    addFiles: (files: File[]) =>
      update(activeRef.current, (current) => {
        const next = [...new Set([...current.files, ...files])];
        if (
          next.length > UPLOAD_MAX_FILES ||
          next.reduce((sum, file) => sum + file.size, 0) > UPLOAD_MAX_BYTES
        )
          return { error: "Attach at most 10 files, totaling at most 20 MB" };
        return { files: next, error: null };
      }),
    removeFile: (index: number) =>
      update(activeRef.current, (current) => ({
        files: current.files.filter((_, candidate) => candidate !== index),
      })),
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
    streamText: tab.streamText,
    activity: tab.activity,
    error: tab.error,
    workspace: tab.workspace,
    workspacePickerSession,
    workspacePickerOpen,
    setWorkspacePickerOpen,
    openWorkspacePicker: (initial: string) => {
      workspacePickerSession.reset(initial);
      setWorkspacePickerOpen(true);
    },
    setWorkspace: (workspace: ChatWorkspace) =>
      update(activeRef.current, (current) =>
        current.thread || current.streaming ? {} : { workspace },
      ),
    config: tab.config,
    setConfig,
    changePermissions,
    applyAgentOptions,
    ready,
    thread: tab.thread,
    openThread,
    historyBefore: tab.historyBefore,
    loadingHistory: tab.loadingHistory,
    loadOlder,
    permission,
    steer,
    respondPermission,
    question,
    respondQuestion,
    responding,
    send,
    cancel,
    streamingId: tab.assistantId,
    streamingAgent: tab.respondingAgent,
    turn: tab.turn,
  };
}
const ChatContext = createContext<ReturnType<typeof useChatController> | null>(null);

/** Keeps `?chatThread=` naming the open conversation while chat is shown, and opens linked ones. */
function useChatLink(chat: ReturnType<typeof useChatController>) {
  const [params, setParams] = useSearchParams();
  const { pathname } = useLocation();
  const param = params.get(CHAT_THREAD_PARAM);
  const linked = param && isChatThreadId(param) ? param : null;
  // The thread is written to the URL for the side panel and for the chat page.
  const chatShown = !!params.get("chat") || pathname === "/chat";
  // While a linked conversation loads the link leads; once it has opened (or failed to), the
  // shown conversation does.
  const loading = useRef<string | null>(null);
  const [_settled, setSettled] = useState(0);
  const { showThread } = chat;
  const current = chat.thread?.id ?? null;
  useEffect(() => {
    if (!linked || linked === loading.current) return;
    loading.current = linked;
    showThread(linked)
      .catch(() => {
        /* a stale or foreign link leaves the current conversation open */
      })
      .finally(() => {
        loading.current = null;
        setSettled((count) => count + 1);
      });
  }, [linked, showThread]);
  useEffect(() => {
    if (!chatShown || loading.current || current === linked) return;
    const next = new URLSearchParams(window.location.search);
    if (current) next.set(CHAT_THREAD_PARAM, current);
    else next.delete(CHAT_THREAD_PARAM);
    setParams(next, { replace: true });
  }, [current, chatShown, linked, setParams]);
}

const threadMessages = new WeakMap<ChatMessage, ThreadMessageLike>();
// Reusing each stored message's converted form keeps assistant-ui's per-message cache warm while tokens stream.
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
          attachments: message.attachments,
          // The message renderer needs the exact text for Copy; the parts tree
          // alone does not expose it outside the assistant-ui slot.
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

export function ChatProvider({ children }: { children: ReactNode }) {
  const chat = useChatController();
  useChatLink(chat);
  const messages = useMemo<ThreadMessageLike[]>(() => {
    const history = chat.messages.map(toThreadMessage);
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
  const runtime = useExternalStoreRuntime({
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
  return createElement(
    ChatContext.Provider,
    { value: chat },
    createElement(AssistantRuntimeProvider, { runtime }, children),
  );
}
export function useChat() {
  const chat = useContext(ChatContext);
  if (!chat) throw new Error("useChat must be used inside ChatProvider");
  return chat;
}
