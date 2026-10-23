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
  ChatSettingsSchema,
  type ChatThread,
} from "@orc/core/chat";
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
  const [permission, setPermission] = useState<{
    requestId: string;
    tool: string;
    command: string;
  } | null>(null);
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
    setPermission(null);
  }, [finishPartial]);
  const openThread = useCallback((next: ChatThread) => {
    if (abortRef.current) return;
    setThread(next);
    history.current = next.messages;
    setMessages(next.messages);
    setConfig(next.config);
    setError(null);
  }, []);
  const clear = useCallback(() => {
    cancel();
    history.current = [];
    setMessages([]);
    setThread(null);
    setConfig(defaults.current);
    setError(null);
  }, [cancel]);

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
        } else if (event.type === "permission_request") setPermission(event.data);
        else {
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
          setPermission(null);
        }
      }
    },
    [config, ready, thread, finishPartial],
  );
  const respondPermission = useCallback(
    async (decision: "approved" | "denied") => {
      if (!permission) return;
      try {
        await api.chat.permission(runId.current, permission.requestId, decision);
        setPermission((current) => (current?.requestId === permission.requestId ? null : current));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Permission could not be sent.");
      }
    },
    [permission],
  );
  return {
    messages,
    streaming,
    streamText,
    activity,
    error,
    config,
    setConfig,
    ready,
    thread,
    openThread,
    permission,
    respondPermission,
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
