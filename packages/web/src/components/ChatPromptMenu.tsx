import { useQuery } from "@tanstack/react-query";
import type { KeyboardEvent } from "react";
import { useState } from "react";
import { api } from "@/api/client";
import { cn } from "@/lib/utils";

type PromptOption = { name: string; title: string; description: string };

/** Typing "/" at the start of an empty composer lists saved MCP prompts, like a native agent. */
export function useChatPromptMenu(draft: string, setDraft: (value: string) => void) {
  const query = draft.match(/^\/(\S*)$/)?.[1];
  const prompts = useQuery({
    queryKey: ["mcp-settings"],
    queryFn: api.settings.mcp.get,
    enabled: query !== undefined,
  });
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const matches: PromptOption[] =
    query === undefined || dismissed === draft
      ? []
      : (prompts.data?.prompts ?? []).filter((prompt) =>
          prompt.name.toLowerCase().startsWith(query.toLowerCase()),
        );
  const index = Math.min(active, Math.max(matches.length - 1, 0));

  function choose(prompt: PromptOption) {
    setDraft(`/${prompt.name} `);
    setActive(0);
  }

  /** Returns true when the menu consumed the key. */
  function onKeyDown(event: KeyboardEvent): boolean {
    if (!matches.length) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index + step + matches.length) % matches.length);
      return true;
    }
    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      event.preventDefault();
      const match = matches[index];
      if (match) choose(match);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(draft);
      return true;
    }
    return false;
  }

  return { matches, index, choose, onKeyDown };
}

export function ChatPromptMenu({
  matches,
  index,
  choose,
}: Pick<ReturnType<typeof useChatPromptMenu>, "matches" | "index" | "choose">) {
  if (!matches.length) return null;
  return (
    <div
      id="chat-prompt-menu"
      role="listbox"
      aria-label="Prompts"
      data-testid="chat-prompt-menu"
      className="mb-1 max-h-60 overflow-y-auto rounded-lg border border-border bg-background p-1"
    >
      {matches.map((prompt, position) => (
        <button
          key={prompt.name}
          type="button"
          tabIndex={-1}
          id={`chat-prompt-${prompt.name}`}
          role="option"
          aria-selected={position === index}
          data-testid="chat-prompt-option"
          className={cn(
            "flex min-h-11 w-full cursor-pointer flex-col justify-center rounded-md px-3 py-1 text-left text-sm",
            position === index ? "bg-surface-highest" : "hover:bg-surface",
          )}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => choose(prompt)}
        >
          <span className="min-w-0 truncate">
            <span className="font-mono">/{prompt.name}</span>
            <span className="ml-2 text-on-surface-variant">{prompt.title}</span>
          </span>
          {prompt.description && (
            <span className="w-full truncate text-xs text-on-surface-variant">
              {prompt.description}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
