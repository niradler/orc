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
} from "@orc/core/chat";
import type { ChatAgentOptions } from "@orc/core/chat-options";
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
import { useSearchParams } from "react-router-dom";
import { ApiError, api, getApiSecret, getApiUrl } from "@/api/client";
import { API_ACCESS_CHANGED } from "@/lib/api-credentials";
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

export type { ChatMessage } from "@orc/core/chat";

/** URL parameter naming the open conversation, so a chat link can be shared. */
export const CHAT_THREAD_PARAM = "chatThread";

interface PendingPermission {
  requestId: string;
  tool: string;
  command: string;
}

/** One open conversation. Each tab streams on its own, so turns keep running in the background. */
export interface ChatTab {
  key: string;
  thread: ChatThread | null;
  config: ChatConfig;
  messages: ChatMessage[];
  draft: string;
  queued: ChatMessage[];
  editingQueuedId: string | null;
  queuedDraft: string;
  queuePaused: boolean;
  historyBefore: number | null;
  loadingHistory: boolean;
  streaming: boolean;
  reconnecting: boolean;
  refreshing: boolean;
  streamText: string;
  activity: ChatActivity[];
  error: string | null;
  permissions: PendingPermission[];
  questions: ChatQuestion[];
  runId: string;
  assistantId: string;
  respondingAgent: string;
  /** A background turn finished or is waiting for a reply since the tab was last viewed. */
  attention: boolean;
}

function blankTab(config: ChatConfig): ChatTab {
  return {
    key: crypto.randomUUID(),
    thread: null,
    config,
    messages: [],
    draft: "",
    queued: [],
    editingQueuedId: null,
    queuedDraft: "",
    queuePaused: false,
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
  !tab.thread && !tab.messages.length && !tab.queued.length && !tab.streaming;

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
      model: config.model,
      ...(config.permissionMode ? { permissionMode: config.permissionMode } : {}),
    }),
  );
}
function authHeaders(): Record<string, string> {
  const secret = getApiSecret();
  return secret ? { Authorization: `Bearer ${secret}` } : {};
}
const message = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : fallback;

function useChatController() {
  const [initial] = useState(() =>
    blankTab(
      withPreferences(DEFAULT_CONFIG, parseChatPreferences(readStorage(CHAT_PREFERENCES_KEY))),
    ),
  );
  const [tabs, setTabs] = useState<ChatTab[]>([initial]);
  const [activeKey, setActiveKey] = useState(initial.key);
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
      update(key, () => ({ attention: false }));
    },
    [update],
  );
  const find = useCallback((key: string) => tabsRef.current.find((tab) => tab.key === key), []);

  const loadSettings = useCallback(async () => {
    try {
      const preferences = await api.settings.get();
      const saved = ChatSettingsSchema.parse(preferences.chat ?? {});
      defaults.current = withPreferences(
        saved,
        parseChatPreferences(readStorage(CHAT_PREFERENCES_KEY)),
      );
      mutate((current) =>
        current.map((tab) => (isBlank(tab) ? { ...tab, config: defaults.current } : tab)),
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
        update(key, () => ({ thread: event.thread, runId: event.runId }));
      } else if (event.type === "text")
        update(key, (tab) => ({ streamText: tab.streamText + event.text }));
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
          tab.streamText || tab.activity.length
            ? [
                ...tab.messages,
                {
                  id: tab.assistantId,
                  role: "assistant",
                  content: tab.streamText,
                  activity: tab.activity,
                  timestamp: Date.now(),
                  agent: tab.respondingAgent,
                },
              ]
            : tab.messages,
        streaming: false,
        reconnecting: false,
        streamText: "",
        activity: [],
        permissions: [],
        questions: [],
        attention: tab.attention || (tab.streaming && key !== activeRef.current),
      })),
    [update],
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
    ): Promise<boolean> => {
      streams.current.get(key)?.controller.abort();
      const stream = { controller: new AbortController(), cancel: false, closed: false };
      streams.current.set(key, stream);
      const current = () => streams.current.get(key) === stream;
      let connect = open;
      let retries = 0;
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
                (retries || tab?.messages[tab.messages.length - 1]?.role === "user")
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
                null,
              );
            }
            if (!response.body) throw new Error("The agent returned no response stream.");
            onOpen?.();
            update(key, () => ({
              reconnecting: false,
              ...(retries
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
            if (!threadId || retries >= 3 || (cause instanceof ApiError && cause.status < 500))
              throw cause;
            retries++;
            update(key, () => ({ reconnecting: true }));
            // Never repeat POST /chat/stream: it may already have started a turn.
            connect = (signal) =>
              fetch(`${getApiUrl()}/chat/threads/${encodeURIComponent(threadId)}/live`, {
                headers: authHeaders(),
                signal,
              });
          } finally {
            clearTimeout(idle);
            connection.abort();
            void reader?.cancel().catch(() => {});
            reader?.releaseLock();
          }
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              stream.controller.signal.removeEventListener("abort", done);
              resolve();
            };
            const timer = setTimeout(done, retries * 1000);
            stream.controller.signal.addEventListener("abort", done, { once: true });
            if (stream.controller.signal.aborted) done();
          });
        }
        return true;
      } catch (cause) {
        if (current() && !stream.controller.signal.aborted)
          update(key, () => ({
            error: `${message(cause, "The chat connection failed.")} Use Refresh to reconnect.`,
          }));
        return true;
      } finally {
        if (current()) {
          streams.current.delete(key);
          finish(key);
        }
      }
    },
    [apply, finish, update, find],
  );
  const attach = useCallback(
    (key: string, threadId: string) =>
      follow(
        key,
        (signal) =>
          fetch(`${getApiUrl()}/chat/threads/${encodeURIComponent(threadId)}/live`, {
            headers: authHeaders(),
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

  const refresh = useCallback(async () => {
    const key = activeRef.current;
    const tab = find(key);
    if (!tab?.thread || tab.refreshing) return;
    update(key, () => ({ refreshing: true, error: null }));
    try {
      const fresh = await api.chat.get(tab.thread.id);
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
  }, [attach, find, update]);

  const openThread = useCallback(
    (next: ChatThread, options: { activate?: boolean; follow?: boolean } = {}) => {
      const existing = tabsRef.current.find((tab) => tab.thread?.id === next.id);
      const loaded = {
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
  const newTab = useCallback(() => {
    const blank = tabsRef.current.find(isBlank);
    if (blank) {
      update(blank.key, () => ({ config: defaults.current, error: null }));
      return activate(blank.key);
    }
    const tab = blankTab(defaults.current);
    mutate((current) => [...current, tab]);
    activate(tab.key);
  }, [activate, mutate, update]);
  const closeTab = useCallback(
    (key: string) => {
      const stream = streams.current.get(key);
      if (stream?.cancel) stream.closed = true;
      else {
        stream?.controller.abort();
        streams.current.delete(key);
      }
      const index = tabsRef.current.findIndex((tab) => tab.key === key);
      const rest = tabsRef.current.filter((tab) => tab.key !== key);
      const remaining = rest.length ? rest : [blankTab(defaults.current)];
      mutate(() => remaining);
      if (activeRef.current === key)
        activate((remaining[Math.min(index, remaining.length - 1)] ?? remaining[0]).key);
    },
    [activate, mutate],
  );

  // Reopen this browser's tabs; a shared link's conversation takes focus over the stored one.
  const [params] = useSearchParams();
  const linked = useRef(params.get(CHAT_THREAD_PARAM));
  useEffect(() => {
    const stored = parseChatTabs(readStorage(CHAT_TABS_KEY));
    void Promise.allSettled(stored.threads.map((id) => api.chat.get(id))).then((results) => {
      for (const result of results)
        if (result.status === "fulfilled")
          openThread(result.value, {
            activate: !linked.current && result.value.id === stored.active,
          });
    });
  }, [openThread]);
  useEffect(() => {
    const threads = tabs.flatMap((tab) => (tab.thread ? [tab.thread.id] : []));
    const active = tabs.find((tab) => tab.key === activeKey)?.thread?.id ?? null;
    writeStorage(CHAT_TABS_KEY, JSON.stringify({ threads, active }));
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

  const sendQueued = useCallback(
    async (key: string, userMessage: ChatMessage) => {
      const current = find(key);
      if (
        !ready ||
        !current ||
        current.streaming ||
        current.refreshing ||
        current.queuePaused ||
        current.editingQueuedId ||
        current.error ||
        current.queued[0]?.id !== userMessage.id ||
        streams.current.has(key)
      )
        return;
      const { config, thread } = current;
      update(key, (tab) => ({
        queued: tab.queued.filter((entry) => entry.id !== userMessage.id),
        messages: [...tab.messages, userMessage],
        streaming: true,
        streamText: "",
        activity: [],
        error: null,
        runId: "",
        assistantId: crypto.randomUUID(),
        respondingAgent: config.agent,
      }));
      await follow(key, (signal) =>
        fetch(`${getApiUrl()}/chat/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({
            messages: [{ role: "user", content: userMessage.content }],
            agent: config.agent,
            model: config.model,
            agentOptions: config.agentOptions,
            ...(config.permissionMode && ["claude", "codex"].includes(config.agent)
              ? { permissionMode: config.permissionMode }
              : {}),
            ...(thread ? { threadId: thread.id } : {}),
          }),
          signal,
        }),
      );
    },
    [ready, follow, update, find],
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
      if (!ready || !find(key) || !input.trim()) return;
      const entry: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: input.trim(),
        timestamp: Date.now(),
      };
      update(key, (tab) => ({
        queued: [...tab.queued, entry],
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
    (draft: string) => update(activeRef.current, () => ({ draft })),
    [update],
  );
  const removeQueued = useCallback(
    (id: string) =>
      update(activeRef.current, (tab) => ({
        queued: tab.queued.filter((entry) => entry.id !== id),
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
      update(key, () => ({
        queued: [entry, ...tab.queued.filter((item) => item.id !== id)],
        queuePaused: false,
        error: null,
      }));
      stop(key);
    },
    [find, stop, update],
  );

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
    tabs,
    activeKey,
    selectTab: activate,
    closeTab,
    newTab,
    showThread,
    messages: tab.messages,
    draft: tab.draft,
    setDraft,
    queued: tab.queued,
    editingQueuedId: tab.editingQueuedId,
    queuedDraft: tab.queuedDraft,
    setQueuedDraft,
    editQueued,
    removeQueued,
    forceQueued,
    streaming: tab.streaming,
    reconnecting: tab.reconnecting,
    refreshing: tab.refreshing,
    refresh,
    streamText: tab.streamText,
    activity: tab.activity,
    error: tab.error,
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
    respondPermission,
    question,
    respondQuestion,
    responding,
    send,
    cancel,
    streamingId: tab.assistantId,
    streamingAgent: tab.respondingAgent,
  };
}
const ChatContext = createContext<ReturnType<typeof useChatController> | null>(null);

/** Keeps `?chatThread=` naming the open conversation while chat is shown, and opens linked ones. */
function useChatLink(chat: ReturnType<typeof useChatController>) {
  const [params, setParams] = useSearchParams();
  const param = params.get(CHAT_THREAD_PARAM);
  const linked = param && isChatThreadId(param) ? param : null;
  const chatShown = !!params.get("chat");
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

export function ChatProvider({ children }: { children: ReactNode }) {
  const chat = useChatController();
  useChatLink(chat);
  const messages = useMemo<ThreadMessageLike[]>(() => {
    const history: ThreadMessageLike[] = chat.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: [{ type: "text", text: message.content }],
      createdAt: new Date(message.timestamp),
      metadata: { custom: { agent: message.agent, activity: message.activity } },
    }));
    if (chat.streaming)
      history.push({
        id: chat.streamingId,
        role: "assistant",
        content: [{ type: "text", text: chat.streamText }],
        status: { type: "running" },
        metadata: { custom: { agent: chat.streamingAgent, activity: chat.activity } },
      });
    return history;
  }, [
    chat.messages,
    chat.streaming,
    chat.streamingId,
    chat.streamingAgent,
    chat.streamText,
    chat.activity,
  ]);
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: (message: ThreadMessageLike) => message,
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
