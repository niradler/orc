import { createLogger } from "@orc/core/logger";
import { useCallback, useRef, useState } from "react";

const logger = createLogger("tui:chat");

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
};

export type ChatConfig = {
  agent: string;
  autoApprove: boolean;
};

type AcpxJsonRpc = {
  jsonrpc?: string;
  id?: number;
  method?: string;
  result?: { stopReason?: string; usage?: unknown };
  error?: { message?: string };
  params?: {
    update?: {
      sessionUpdate?: string;
      content?:
        | { type?: string; text?: string }
        | Array<{ type?: string; content?: { type?: string; text?: string } }>;
    };
  };
};

function parseTextFromLine(line: string): string | null {
  let msg: AcpxJsonRpc;
  try {
    msg = JSON.parse(line) as AcpxJsonRpc;
  } catch {
    return null;
  }
  if (msg.error) return `[Error] ${msg.error.message ?? "Unknown error"}`;
  if (msg.method === "session/update" && msg.params?.update) {
    const u = msg.params.update;
    if (u.sessionUpdate === "agent_message_chunk" && u.content) {
      if (!Array.isArray(u.content)) {
        if (u.content.type === "text" && u.content.text) return u.content.text;
      } else {
        const texts: string[] = [];
        for (const item of u.content) {
          if (item.content?.type === "text" && item.content.text) texts.push(item.content.text);
        }
        if (texts.length > 0) return texts.join("");
      }
    }
  }
  return null;
}

async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) onLine(line);
      }
    }
    if (buf.trim()) onLine(buf);
  } finally {
    reader.releaseLock();
  }
}

const DEFAULT_CONFIG: ChatConfig = {
  agent: "claude",
  autoApprove: true,
};

const MAX_HISTORY_CHARS = 24000;

function trimHistory(history: ChatMessage[]): ChatMessage[] {
  let total = 0;
  const result: ChatMessage[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (!msg) continue;
    total += msg.content.length;
    if (total > MAX_HISTORY_CHARS) break;
    result.unshift(msg);
  }
  return result;
}

export function useChat(buildSystemPrompt: () => string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [config, setConfig] = useState<ChatConfig>(DEFAULT_CONFIG);
  const procRef = useRef<ReturnType<typeof Bun.spawn> | null>(null);
  const cancelledRef = useRef(false);
  const streamingRef = useRef(false);
  const messagesRef = useRef<ChatMessage[]>([]);
  const buildSystemPromptRef = useRef(buildSystemPrompt);
  buildSystemPromptRef.current = buildSystemPrompt;
  const configRef = useRef(config);
  configRef.current = config;

  const buildPrompt = useCallback((userMsg: string, history: ChatMessage[]): string => {
    const system = buildSystemPromptRef.current();
    const trimmed = trimHistory(history);
    const parts: string[] = [`<system>\n${system}\n</system>\n`];
    for (const msg of trimmed) {
      if (msg.role === "user") parts.push(`<user>\n${msg.content}\n</user>\n`);
      else if (msg.role === "assistant") parts.push(`<assistant>\n${msg.content}\n</assistant>\n`);
    }
    parts.push(`<user>\n${userMsg}\n</user>`);
    return parts.join("\n");
  }, []);

  const addMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => {
      const next = [...prev, msg];
      messagesRef.current = next;
      return next;
    });
  }, []);

  const send = useCallback(
    async (userMsg: string) => {
      if (streamingRef.current || !userMsg.trim()) return;

      const trimmed = userMsg.trim();
      const userMessage: ChatMessage = { role: "user", content: trimmed, timestamp: Date.now() };
      addMessage(userMessage);

      const acpxPath = Bun.which("acpx");
      if (!acpxPath) {
        addMessage({
          role: "assistant",
          content: "[Error] acpx CLI not found on PATH.",
          timestamp: Date.now(),
        });
        return;
      }

      const prompt = buildPrompt(trimmed, messagesRef.current.slice(0, -1));
      const cfg = configRef.current;
      const args = [
        acpxPath.replaceAll("\\", "/"),
        "--format",
        "json",
        ...(cfg.autoApprove ? ["--approve-all"] : []),
        cfg.agent,
        "exec",
        prompt,
      ];

      streamingRef.current = true;
      setStreaming(true);
      setStreamText("");
      cancelledRef.current = false;
      let accumulated = "";
      let stderrBuf = "";

      try {
        const proc = Bun.spawn({
          cmd: args,
          cwd: process.cwd(),
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
        });
        procRef.current = proc;

        if (proc.stdout) {
          await readLines(proc.stdout, (line) => {
            if (cancelledRef.current) return;
            const text = parseTextFromLine(line);
            if (text) {
              accumulated += text;
              setStreamText(accumulated);
            }
          });
        }
        if (proc.stderr) {
          await readLines(proc.stderr, (line) => {
            stderrBuf += `${line}\n`;
          }).catch(() => {});
        }

        const exitCode = await proc.exited;
        if (exitCode !== 0 && !accumulated && stderrBuf) {
          accumulated = `[Error] acpx exited ${exitCode}: ${stderrBuf.trim()}`;
        }
      } catch (err) {
        logger.error("Chat process error", { err });
        if (!accumulated) accumulated = `[Error] ${String(err)}`;
      } finally {
        procRef.current = null;
        streamingRef.current = false;
        setStreaming(false);
        setStreamText("");
        if (accumulated && !cancelledRef.current) {
          addMessage({ role: "assistant", content: accumulated, timestamp: Date.now() });
        } else if (!accumulated && !cancelledRef.current) {
          addMessage({
            role: "assistant",
            content: "[No response received]",
            timestamp: Date.now(),
          });
        }
      }
    },
    [buildPrompt, addMessage],
  );

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    if (procRef.current) {
      procRef.current.kill();
      procRef.current = null;
    }
    streamingRef.current = false;
    setStreaming(false);
    setStreamText("");
  }, []);

  const clear = useCallback(() => {
    cancel();
    setMessages([]);
    messagesRef.current = [];
  }, [cancel]);

  return { messages, streaming, streamText, config, setConfig, send, cancel, clear };
}
