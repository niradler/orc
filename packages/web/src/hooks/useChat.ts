import {
  type AppendMessage,
  AssistantRuntimeProvider,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import {
  appendChatActivity,
  type ChatActivity,
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
import { api, getApiSecret, getApiUrl } from "@/api/client";
import { API_ACCESS_CHANGED } from "@/lib/api-credentials";
import { type ChatConfig, DEFAULT_CONFIG, parseChatEvent } from "./chat-contract";

export type { ChatMessage } from "@orc/core/chat";

function useChatController() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [activity, setActivity] = useState<ChatActivity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<ChatConfig>(DEFAULT_CONFIG);
  const [ready, setReady] = useState(false);
  const [thread, setThread] = useState<ChatThread | null>(null);
  const [historyBefore, setHistoryBefore] = useState<number | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const historyRequest = useRef<symbol | null>(null);
  const [permissions, setPermissions] = useState<
    {
      requestId: string;
      tool: string;
      command: string;
    }[]
  >([]);
  const permission = permissions[0] ?? null;
  const [questions, setQuestions] = useState<ChatQuestion[]>([]);
  const question = questions[0] ?? null;
  const [responding, setResponding] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const partial = useRef("");
  const activities = useRef<ChatActivity[]>([]);
  const assistantId = useRef("");
  const runId = useRef("");
  const respondingAgent = useRef(config.agent);
  const history = useRef(messages);
  history.current = messages;
  const currentThread = useRef(thread);
  currentThread.current = thread;
  const defaults = useRef(DEFAULT_CONFIG);

  const loadSettings = useCallback(async () => {
    try {
      const preferences = await api.settings.get();
      const saved = ChatSettingsSchema.parse(preferences.chat ?? {});
      defaults.current = saved;
      if (!currentThread.current) setConfig(saved);
      setReady(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Chat settings could not be loaded.");
    }
  }, []);
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
      generation.current++;
      historyRequest.current = null;
      abortRef.current?.abort();
    },
    [],
  );

  const finishPartial = useCallback(() => {
    if (!partial.current && !activities.current.length) return;
    const message: ChatMessage = {
      id: assistantId.current,
      role: "assistant",
      content: partial.current,
      activity: activities.current,
      timestamp: Date.now(),
      agent: respondingAgent.current,
    };
    partial.current = "";
    activities.current = [];
    setMessages((current) => [...current, message]);
  }, []);
  const cancel = useCallback(() => {
    generation.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    finishPartial();
    setStreaming(false);
    setStreamText("");
    setActivity([]);
    setPermissions([]);
    setQuestions([]);
  }, [finishPartial]);
  const openThread = useCallback((next: ChatThread) => {
    if (abortRef.current) return;
    historyRequest.current = null;
    setLoadingHistory(false);
    setHistoryBefore(next.historyBefore ?? null);
    setThread(next);
    history.current = next.messages;
    setMessages(next.messages);
    setConfig(next.config);
    setError(null);
  }, []);
  const clear = useCallback(() => {
    cancel();
    historyRequest.current = null;
    setLoadingHistory(false);
    setHistoryBefore(null);
    history.current = [];
    setMessages([]);
    setThread(null);
    setConfig(defaults.current);
    setError(null);
  }, [cancel]);

  const loadOlder = useCallback(async () => {
    const current = currentThread.current;
    if (!current || historyBefore === null || historyRequest.current) return;
    const request = Symbol();
    historyRequest.current = request;
    setLoadingHistory(true);
    setError(null);
    try {
      const page = await api.chat.history(current.id, historyBefore);
      if (historyRequest.current !== request) return;
      setHistoryBefore(page.before);
      setMessages((messages) => [...page.messages, ...messages]);
    } catch (cause) {
      if (historyRequest.current === request)
        setError(cause instanceof Error ? cause.message : "Older messages could not be loaded.");
    } finally {
      if (historyRequest.current === request) {
        historyRequest.current = null;
        setLoadingHistory(false);
      }
    }
  }, [historyBefore]);

  const send = useCallback(
    async (input: string) => {
      if (!ready || abortRef.current || !input.trim()) return;
      const userMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: input.trim(),
        timestamp: Date.now(),
      };
      const requestMessages = [...history.current, userMessage];
      history.current = requestMessages;
      setMessages(requestMessages);
      const controller = new AbortController();
      const currentGeneration = ++generation.current;
      abortRef.current = controller;
      assistantId.current = crypto.randomUUID();
      respondingAgent.current = config.agent;
      partial.current = "";
      activities.current = [];
      setActivity([]);
      setStreamText("");
      setError(null);
      setStreaming(true);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const apply = (line: string) => {
        if (generation.current !== currentGeneration) return;
        const event = parseChatEvent(line);
        if (!event) return;
        if (event.type === "text") {
          partial.current += event.text;
          setStreamText(partial.current);
        } else if (event.type === "error") setError(event.message);
        else if (event.type === "thread") {
          setThread(event.thread);
          runId.current = event.runId;
        } else if (event.type === "session") {
          setThread((current) => (current ? { ...current, runtimeId: event.runtimeId } : current));
        } else if (event.type === "permission_request")
          setPermissions((current) => [...current, event.data]);
        else if (event.type === "question_request")
          setQuestions((current) => [...current, event.data]);
        else if (event.type === "request_resolved") {
          setPermissions((current) =>
            current.filter((request) => request.requestId !== event.requestId),
          );
          setQuestions((current) =>
            current.filter((request) => request.requestId !== event.requestId),
          );
        } else {
          activities.current = appendChatActivity(activities.current, event);
          setActivity(activities.current);
        }
      };
      try {
        const secret = getApiSecret();
        const response = await fetch(`${getApiUrl()}/chat/stream`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
          },
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
          signal: controller.signal,
        });
        if (response.status === 401) window.dispatchEvent(new Event(API_ACCESS_CHANGED));
        if (!response.ok) {
          const body: unknown = await response.json().catch(() => null);
          throw new Error(
            body && typeof body === "object" && "error" in body && typeof body.error === "string"
              ? body.error
              : `Chat request failed (HTTP ${response.status}).`,
          );
        }
        if (!response.body) throw new Error("The agent returned no response stream.");
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (generation.current !== currentGeneration) break;
          buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) apply(line);
          if (done) {
            if (buffer.trim()) apply(buffer);
            break;
          }
        }
      } catch (cause) {
        if (generation.current === currentGeneration && !controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "The chat connection failed.");
      } finally {
        reader?.releaseLock();
        if (generation.current === currentGeneration) {
          abortRef.current = null;
          finishPartial();
          setStreaming(false);
          setStreamText("");
          setActivity([]);
          setPermissions([]);
          setQuestions([]);
        }
      }
    },
    [config, ready, thread, finishPartial],
  );
  const respondPermission = useCallback(
    async (decision: "approved" | "denied") => {
      if (!permission || responding) return;
      setResponding(true);
      try {
        await api.chat.permission(runId.current, permission.requestId, decision);
        setPermissions((current) =>
          current.filter((request) => request.requestId !== permission.requestId),
        );
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Permission could not be sent.");
      } finally {
        setResponding(false);
      }
    },
    [permission, responding],
  );
  const respondQuestion = useCallback(
    async (answers: Record<string, string[]>) => {
      if (!question || responding) return;
      setResponding(true);
      try {
        await api.chat.answer(runId.current, question.requestId, answers);
        setQuestions((current) =>
          current.filter((request) => request.requestId !== question.requestId),
        );
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Answer could not be sent.");
      } finally {
        setResponding(false);
      }
    },
    [question, responding],
  );
  // While the agent is responding the change goes to the live run, which approves prompts
  // the new mode would not ask for; otherwise it applies to the next message.
  const changePermissions = useCallback(
    async (next: ChatConfig) => {
      setConfig(next);
      const mode = next.permissionMode;
      if (!mode || !streaming || !runId.current) return;
      try {
        const updated = await api.chat.permissionMode(runId.current, mode);
        if (currentThread.current?.id !== updated.id) return;
        setThread(updated);
        setConfig((current) => ({
          ...current,
          permissionMode: updated.config.permissionMode,
          agentOptions: updated.config.agentOptions,
        }));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Permissions could not be changed.");
      }
    },
    [streaming],
  );
  const applyAgentOptions = useCallback(
    async (agent: string, options: ChatAgentOptions) => {
      const target = currentThread.current;
      const agentOptions = { ...config.agentOptions, [agent]: options };
      if (target) await api.chat.configure(target.id, agentOptions);
      if (currentThread.current?.id !== target?.id) return false;
      setConfig((current) =>
        current.agent === agent
          ? { ...current, agentOptions: { ...current.agentOptions, [agent]: options } }
          : current,
      );
      return true;
    },
    [config.agentOptions],
  );
  return {
    messages,
    streaming,
    streamText,
    activity,
    error,
    config,
    setConfig,
    changePermissions,
    applyAgentOptions,
    ready,
    thread,
    openThread,
    historyBefore,
    loadingHistory,
    loadOlder,
    permission,
    respondPermission,
    question,
    respondQuestion,
    responding,
    send,
    cancel,
    clear,
    streamingId: assistantId.current,
    streamingAgent: respondingAgent.current,
  };
}
const ChatContext = createContext<ReturnType<typeof useChatController> | null>(null);
export function ChatProvider({ children }: { children: ReactNode }) {
  const chat = useChatController();
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
