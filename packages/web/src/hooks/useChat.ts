import { useCallback, useRef, useState } from "react";
import { getApiSecret, getApiUrl } from "@/api/client";

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
};

export type ChatConfig = {
  agent: string;
  autoApprove: boolean;
};

const DEFAULT_CONFIG: ChatConfig = {
  agent: "claude",
  autoApprove: true,
};

const DEFAULT_SYSTEM =
  "You are an AI assistant integrated into the ORC orchestration hub. Help users manage tasks, review agent activity, and answer questions about the system.";

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [config, setConfig] = useState<ChatConfig>(DEFAULT_CONFIG);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (userMsg: string) => {
      if (streaming || !userMsg.trim()) return;

      const trimmed = userMsg.trim();
      const userMessage: ChatMessage = {
        role: "user",
        content: trimmed,
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, userMessage]);
      setStreaming(true);
      setStreamText("");

      const controller = new AbortController();
      abortRef.current = controller;

      let accumulated = "";

      try {
        const apiUrl = getApiUrl();
        const secret = getApiSecret();
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (secret) headers["Authorization"] = `Bearer ${secret}`;

        const allMessages = [...messages, userMessage].map((m) => ({
          role: m.role,
          content: m.content,
        }));

        const res = await fetch(`${apiUrl}/chat/stream`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            messages: allMessages,
            agent: config.agent,
            system: DEFAULT_SYSTEM,
            autoApprove: config.autoApprove,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
        }

        if (!res.body) throw new Error("No response body");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const json = line.slice(6).trim();
            if (!json) continue;
            try {
              const event = JSON.parse(json) as {
                type: string;
                text?: string;
                message?: string;
              };
              if (event.type === "text" && event.text) {
                accumulated += event.text;
                setStreamText(accumulated);
              } else if (event.type === "error") {
                accumulated += `\n[Error] ${event.message ?? "Unknown error"}`;
                setStreamText(accumulated);
              }
            } catch {
              // skip malformed SSE data
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          // User cancelled
        } else {
          accumulated = accumulated || `[Error] ${(err as Error).message}`;
        }
      } finally {
        abortRef.current = null;
        setStreaming(false);
        setStreamText("");
        if (accumulated) {
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: accumulated,
              timestamp: Date.now(),
            },
          ]);
        }
      }
    },
    [messages, streaming, config],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    setStreamText("");
  }, []);

  const clear = useCallback(() => {
    cancel();
    setMessages([]);
  }, [cancel]);

  return {
    messages,
    streaming,
    streamText,
    config,
    setConfig,
    send,
    cancel,
    clear,
  };
}
