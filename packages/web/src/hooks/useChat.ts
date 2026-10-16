import {
  type AppendMessage,
  AssistantRuntimeProvider,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
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
import { getApiSecret, getApiUrl } from "@/api/client";
import { API_ACCESS_CHANGED } from "@/lib/api-credentials";
import {
  CHAT_CONFIG_KEY,
  type ChatConfig,
  DEFAULT_CONFIG,
  parseChatConfig,
  parseChatEvent,
} from "./chat-contract";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  agent?: string;
};
const DEFAULT_SYSTEM =
  "You are an AI assistant integrated into the ORC orchestration hub. Help users manage tasks, review agent activity, and answer questions about the system.";

function useChatController() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<ChatConfig>(() => {
    try {
      return parseChatConfig(localStorage.getItem(CHAT_CONFIG_KEY));
    } catch {
      return DEFAULT_CONFIG;
    }
  });
  const abortRef = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const partial = useRef("");
  const assistantId = useRef("");
  const respondingAgent = useRef(config.agent);
  const history = useRef(messages);
  history.current = messages;
  useEffect(() => {
    try {
      localStorage.setItem(CHAT_CONFIG_KEY, JSON.stringify(config));
    } catch {
      /* Session preferences still work without storage. */
    }
  }, [config]);
  useEffect(
    () => () => {
      generation.current++;
      abortRef.current?.abort();
    },
    [],
  );

  const finishPartial = useCallback(() => {
    if (!partial.current) return;
    const message: ChatMessage = {
      id: assistantId.current,
      role: "assistant",
      content: partial.current,
      timestamp: Date.now(),
      agent: respondingAgent.current,
    };
    partial.current = "";
    setMessages((current) => [...current, message]);
  }, []);

  const cancel = useCallback(() => {
    generation.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    finishPartial();
    setStreaming(false);
    setStreamText("");
  }, [finishPartial]);

  const send = useCallback(
    async (input: string) => {
      if (abortRef.current || !input.trim()) return;
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
      setStreamText("");
      setError(null);
      setStreaming(true);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const apply = (line: string) => {
        if (generation.current !== currentGeneration) return;
        const event = parseChatEvent(line);
        if (event?.type === "text") {
          partial.current += event.text;
          setStreamText(partial.current);
        } else if (event?.type === "error") setError(event.message);
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
            messages: requestMessages.map(({ role, content }) => ({ role, content })),
            agent: config.agent,
            system: DEFAULT_SYSTEM,
            autoApprove: config.autoApprove,
          }),
          signal: controller.signal,
        });
        if (response.status === 401) window.dispatchEvent(new Event(API_ACCESS_CHANGED));
        if (!response.ok) {
          const body: unknown = await response.json().catch(() => null);
          const message =
            body && typeof body === "object" && "error" in body && typeof body.error === "string"
              ? body.error
              : `Chat request failed (HTTP ${response.status}).`;
          throw new Error(message);
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
        }
      }
    },
    [config, finishPartial],
  );

  const clear = useCallback(() => {
    cancel();
    history.current = [];
    setMessages([]);
    setError(null);
  }, [cancel]);
  return {
    messages,
    streaming,
    streamText,
    error,
    config,
    setConfig,
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
      metadata: { custom: { agent: message.agent } },
    }));
    if (chat.streaming)
      history.push({
        id: chat.streamingId,
        role: "assistant",
        content: [{ type: "text", text: chat.streamText }],
        status: { type: "running" },
        metadata: { custom: { agent: chat.streamingAgent } },
      });
    return history;
  }, [chat.messages, chat.streaming, chat.streamingId, chat.streamingAgent, chat.streamText]);
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: (message: ThreadMessageLike) => message,
    isRunning: chat.streaming,
    onNew: async (message: AppendMessage) => {
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      await chat.send(text);
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
