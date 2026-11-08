import { useQuery } from "@tanstack/react-query";
import type { KeyboardEvent, RefObject } from "react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { activeCommand, type CommandOption, rankCommands } from "@/lib/chat-commands";
import { cn } from "@/lib/utils";

/**
 * Typing "/" anywhere in the composer lists saved prompts and ORC skills, like a native agent.
 * Several commands can be combined; the server expands each one when the message is sent.
 */
export function useChatPromptMenu(
  draft: string,
  setDraft: (value: string) => void,
  input: RefObject<HTMLTextAreaElement | null>,
  projectId: string | null,
) {
  const [caret, setCaret] = useState(0);
  const command = activeCommand(draft, Math.min(caret, draft.length));
  const wanted = draft.includes("/");
  const prompts = useQuery({
    queryKey: ["mcp-settings"],
    queryFn: api.settings.mcp.get,
    enabled: wanted,
  });
  const skills = useQuery({
    queryKey: ["chat-command-skills", projectId],
    queryFn: () => api.skills.list({ limit: 500, ...(projectId ? { project_id: projectId } : {}) }),
    enabled: wanted,
    staleTime: 60_000,
  });
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const dismissKey = command ? `${command.start}:${draft}` : null;
  useEffect(() => {
    if (dismissed !== null && dismissed !== dismissKey) setDismissed(null);
  }, [dismissed, dismissKey]);
  const promptOptions: CommandOption[] = (prompts.data?.prompts ?? []).map((prompt) => ({
    name: prompt.name,
    kind: "prompt",
    title: prompt.title,
    description: prompt.description,
  }));
  const promptNames = new Set(promptOptions.map((option) => option.name));
  const skillOptions: CommandOption[] = (skills.data?.skills ?? [])
    .filter((skill) => !promptNames.has(skill.name))
    .map((skill) => ({
      name: skill.name,
      kind: "skill",
      title: "",
      description: skill.description,
    }));
  const matches =
    !command || dismissed === dismissKey
      ? []
      : rankCommands([...promptOptions, ...skillOptions], command.query);
  const index = Math.min(active, Math.max(matches.length - 1, 0));
  const commandNames = useMemo(
    () =>
      new Set([
        ...(prompts.data?.prompts ?? []).map((prompt) => prompt.name),
        ...(skills.data?.skills ?? []).map((skill) => skill.name),
      ]),
    [prompts.data, skills.data],
  );

  function syncCaret() {
    if (input.current) setCaret(input.current.selectionStart);
  }

  function choose(option: CommandOption) {
    if (!command) return;
    const end = command.start + 1 + command.query.length;
    const rest = draft.slice(end);
    const inserted = `/${option.name}${rest.startsWith(" ") ? "" : " "}`;
    const next = draft.slice(0, command.start) + inserted + rest;
    const position = command.start + inserted.length + (rest.startsWith(" ") ? 1 : 0);
    setDraft(next);
    setCaret(position);
    setActive(0);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(position, position);
    });
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
      setDismissed(dismissKey);
      return true;
    }
    return false;
  }

  return {
    matches,
    index,
    choose,
    onKeyDown,
    syncCaret,
    commandNames,
    anchor: input,
    dismiss: () => setDismissed(dismissKey),
  };
}

export function chatCommandOptionId(option: CommandOption) {
  return `chat-prompt-${option.kind}-${option.name.replace(/[^\p{L}\p{N}_-]/gu, "_")}`;
}

export function ChatPromptMenu({
  matches,
  index,
  choose,
  anchor,
  dismiss,
}: Pick<
  ReturnType<typeof useChatPromptMenu>,
  "matches" | "index" | "choose" | "anchor" | "dismiss"
>) {
  const activeId = matches[index] ? chatCommandOptionId(matches[index]) : null;
  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);
  if (!matches.length) return null;
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <PopoverAnchor virtualRef={anchor} />
      <PopoverContent
        id="chat-prompt-menu"
        role="listbox"
        aria-label="Prompts and skills"
        data-testid="chat-prompt-menu"
        side="top"
        align="start"
        className="w-[var(--radix-popover-trigger-width)] max-h-[min(15rem,var(--radix-popover-content-available-height))] p-1"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          if (anchor.current?.contains(event.target as Node)) event.preventDefault();
        }}
      >
        {matches.map((option, position) => (
          <button
            key={`${option.kind}:${option.name}`}
            type="button"
            tabIndex={-1}
            id={chatCommandOptionId(option)}
            role="option"
            aria-selected={position === index}
            data-testid="chat-prompt-option"
            data-kind={option.kind}
            className={cn(
              "flex min-h-11 w-full cursor-pointer flex-col justify-center rounded-md px-3 py-1 text-left text-sm",
              position === index ? "bg-surface-highest" : "hover:bg-surface",
            )}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => choose(option)}
          >
            <span className="flex w-full min-w-0 items-center gap-2">
              <span className="min-w-0 truncate font-mono">/{option.name}</span>
              {option.title && (
                <span className="min-w-0 truncate text-on-surface-variant">{option.title}</span>
              )}
              <span className="ml-auto shrink-0 rounded px-1.5 text-xs text-on-surface-variant ring-1 ring-border">
                {option.kind}
              </span>
            </span>
            {option.description && (
              <span className="w-full truncate text-xs text-on-surface-variant">
                {option.description}
              </span>
            )}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
