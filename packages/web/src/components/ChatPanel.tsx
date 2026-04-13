import { MessageSquare, Send, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type ChatConfig, useChat } from "@/hooks/useChat";

interface ChatPanelProps {
  open: boolean;
  onToggle: () => void;
}

export function ChatPanel({ open, onToggle }: ChatPanelProps) {
  const { messages, streaming, streamText, config, setConfig, send, cancel, clear } = useChat();
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamText]);

  const handleSend = () => {
    if (!input.trim() || streaming) return;
    send(input.trim());
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const agents = ["claude", "codex", "gemini", "copilot"];

  if (!open) {
    return (
      <div
        data-testid="chat-panel-collapsed"
        className="fixed top-0 right-0 h-full w-12 z-40 bg-surface border-l border-surface-highest flex flex-col items-center pt-4 gap-3"
      >
        <button
          data-testid="chat-open-button"
          onClick={onToggle}
          className="text-outline hover:text-primary transition-colors p-1.5"
          title="Open Chat"
        >
          <MessageSquare size={16} />
        </button>
        <span className="text-[9px] font-label text-outline uppercase tracking-widest [writing-mode:vertical-lr] rotate-180">
          Chat
        </span>
      </div>
    );
  }

  return (
    <div
      data-testid="chat-panel"
      data-streaming={streaming ? "true" : "false"}
      className="fixed top-0 right-0 h-full w-80 z-40 flex flex-col bg-surface border-l border-surface-highest transition-all duration-200"
    >
      {/* Header */}
      <div className="flex-shrink-0 px-4 py-3 border-b border-surface-highest">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-primary text-sm">&#x25C8;</span>
            <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant">
              Chat
            </span>
            <span className="font-label text-[9px] text-outline">&middot; {config.agent}</span>
            <span
              className={`w-1.5 h-1.5 rounded-full ${streaming ? "bg-secondary animate-pulse" : "bg-outline"}`}
            />
          </div>
          <button
            onClick={onToggle}
            className="text-outline hover:text-on-surface-variant transition-colors p-1"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Messages area */}
      <div
        ref={scrollRef}
        data-testid="chat-messages"
        className="flex-1 overflow-y-auto px-3 py-3 space-y-3"
      >
        {messages.length === 0 && !streaming && (
          <div className="flex items-center justify-center h-full">
            <p className="text-outline text-[10px] font-label uppercase tracking-widest text-center leading-relaxed">
              Ask a question about
              <br />
              your tasks or agents
            </p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} data-testid="chat-message" data-role={msg.role}>
            <span
              className={`font-label text-[9px] uppercase tracking-widest ${msg.role === "user" ? "text-primary" : "text-secondary"}`}
            >
              {msg.role === "user" ? "You" : config.agent}
            </span>
            <p
              data-testid="chat-message-content"
              className="text-on-surface font-mono text-xs mt-0.5 whitespace-pre-wrap leading-relaxed"
            >
              {msg.content}
            </p>
          </div>
        ))}

        {streaming && streamText && (
          <div data-testid="chat-streaming">
            <span className="font-label text-[9px] uppercase tracking-widest text-secondary">
              {config.agent}
            </span>
            <p
              data-testid="chat-streaming-content"
              className="text-on-surface font-mono text-xs mt-0.5 whitespace-pre-wrap leading-relaxed"
            >
              {streamText}
              <span className="animate-pulse text-primary">&#x258C;</span>
            </p>
          </div>
        )}
      </div>

      {/* Separator */}
      <div className="border-t border-surface-highest" />

      {/* Input area */}
      <div className="flex-shrink-0 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-primary font-mono text-xs">&gt;</span>
          <input
            data-testid="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            className="flex-1 bg-transparent text-on-surface font-mono text-xs outline-none placeholder:text-outline"
            disabled={streaming}
          />
          {streaming ? (
            <button
              data-testid="chat-cancel-button"
              onClick={cancel}
              className="text-error hover:text-error/80 transition-colors p-1"
            >
              <X size={12} />
            </button>
          ) : (
            <button
              data-testid="chat-send-button"
              onClick={handleSend}
              disabled={!input.trim()}
              className="text-primary hover:text-primary/80 transition-colors p-1 disabled:text-outline"
            >
              <Send size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Controls */}
      <div className="flex-shrink-0 px-3 py-2 border-t border-surface-highest flex items-center justify-between">
        <select
          data-testid="chat-agent-select"
          value={config.agent}
          onChange={(e) => setConfig({ ...config, agent: e.target.value })}
          className="bg-surface-highest text-outline font-label text-[9px] uppercase tracking-widest px-2 py-1 rounded-sm border border-surface-highest cursor-pointer"
        >
          {agents.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <button
          onClick={clear}
          className="text-outline hover:text-error transition-colors p-1"
          title="Clear chat"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}
