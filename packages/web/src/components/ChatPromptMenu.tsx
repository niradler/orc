import { useQuery } from "@tanstack/react-query";
import type { KeyboardEvent, RefObject } from "react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { useChat } from "@/hooks/useChat";
import { useSsh } from "@/hooks/useSsh";
import {
  activeCommand,
  activeMention,
  type CommandOption,
  mentionToken,
  rankCommands,
} from "@/lib/chat-commands";
import { folderHistory } from "@/lib/folder-history";
import { cn } from "@/lib/utils";

export function useChatPromptMenu(
  draft: string,
  setDraft: (value: string) => void,
  input: RefObject<HTMLTextAreaElement | null>,
  projectId: string | null,
) {
  const { config, thread, workspace } = useChat();
  const { data: ssh } = useSsh();
  const host = workspace?.host === undefined ? (ssh?.host ?? null) : workspace.host;
  const cwd = thread ? undefined : (workspace?.cwd ?? folderHistory(host).last ?? undefined);
  const [caret, setCaret] = useState(0);
  const position = Math.min(caret, draft.length);
  const command = activeCommand(draft, position);
  const mention = command ? null : activeMention(draft, position);
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
  const agentCommands = useQuery({
    queryKey: ["chat-agent-commands", config.agent, config.providerId, thread?.id, host],
    queryFn: () =>
      api.chat.commands(
        config.agent,
        thread?.id,
        thread ? undefined : host,
        config.providerId ?? undefined,
      ),
    enabled: !!command,
    staleTime: 60_000,
    retry: false,
  });
  const files = useQuery({
    queryKey: ["chat-files", thread?.id ?? [host, cwd], mention?.folder],
    queryFn: () =>
      api.chat.files(mention?.folder ?? "", thread?.id, thread ? undefined : host, cwd),
    enabled: !!mention,
    staleTime: 15_000,
    retry: false,
  });
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const trigger = command ?? mention;
  const dismissKey = trigger ? `${trigger.start}:${draft}` : null;
  useEffect(() => {
    if (dismissed !== null && dismissed !== dismissKey) setDismissed(null);
  }, [dismissed, dismissKey]);
  const promptOptions: CommandOption[] = (prompts.data?.prompts ?? []).map((prompt) => ({
    name: prompt.name,
    kind: "prompt",
    title: prompt.title,
    description: prompt.description,
  }));
  const orcNames = new Set(promptOptions.map((option) => option.name));
  const skillOptions: CommandOption[] = (skills.data?.skills ?? [])
    .filter((skill) => !orcNames.has(skill.name))
    .map((skill) => ({
      name: skill.name,
      kind: "skill",
      title: "",
      description: skill.description,
    }));
  for (const option of skillOptions) orcNames.add(option.name);
  const agentOptions: CommandOption[] = (agentCommands.data?.commands ?? [])
    .filter((entry) => !orcNames.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      kind: "agent",
      title: entry.argumentHint,
      description: entry.description,
      token: entry.token,
      source: entry.source,
      aliases: entry.aliases,
    }));
  const fileOptions: CommandOption[] = (mention ? (files.data?.entries ?? []) : [])
    .filter((entry) => mention?.leaf.startsWith(".") || !entry.name.startsWith("."))
    .map((entry) => ({
      name: entry.name,
      kind: entry.directory ? "folder" : "file",
      title: "",
      description: "",
    }));
  const open = !!trigger && dismissed !== dismissKey;
  const matches = !open
    ? []
    : command
      ? rankCommands([...promptOptions, ...skillOptions, ...agentOptions], command.query)
      : rankCommands(fileOptions, mention?.leaf ?? "");
  const loading = command
    ? prompts.isLoading || skills.isLoading || agentCommands.isLoading
    : files.isLoading;
  const status = !open
    ? null
    : !command && files.isError
      ? "This folder could not be read on the session's host."
      : matches.length
        ? command
          ? (agentCommands.data?.warning ?? null)
          : null
        : loading
          ? command
            ? "Loading commands…"
            : "Loading files…"
          : command
            ? (agentCommands.data?.warning ?? "No matching commands.")
            : "No matching files or folders.";
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
    if (!trigger) return;
    const end = trigger.start + 1 + trigger.query.length;
    const rest = draft.slice(end);
    const folder = option.kind === "folder";
    const text = mention
      ? folder
        ? `@${mention.folder}${option.name}/`
        : mentionToken(`${mention.folder}${option.name}`)
      : (option.token ?? `/${option.name}`);
    const inserted = `${text}${folder || rest.startsWith(" ") ? "" : " "}`;
    const next = draft.slice(0, trigger.start) + inserted + rest;
    const at = trigger.start + inserted.length + (!folder && rest.startsWith(" ") ? 1 : 0);
    setDraft(next);
    setCaret(at);
    setActive(0);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(at, at);
    });
  }

  /** Returns true when the menu consumed the key. */
  function onKeyDown(event: KeyboardEvent): boolean {
    if (!open || (!matches.length && !status)) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(dismissKey);
      return true;
    }
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
    return false;
  }

  return {
    matches,
    status,
    open: open && (matches.length > 0 || !!status),
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
  status,
  open,
  index,
  choose,
  anchor,
  dismiss,
}: Pick<
  ReturnType<typeof useChatPromptMenu>,
  "matches" | "status" | "open" | "index" | "choose" | "anchor" | "dismiss"
>) {
  const activeId = matches[index] ? chatCommandOptionId(matches[index]) : null;
  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);
  if (!open) return null;
  return (
    <Popover
      open
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
    >
      <PopoverAnchor virtualRef={anchor} />
      <PopoverContent
        id="chat-prompt-menu"
        role="listbox"
        aria-label="Commands, skills and files"
        aria-busy={status?.startsWith("Loading") || undefined}
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
        {status && (
          <p
            role="status"
            data-testid="chat-prompt-status"
            className="px-3 py-2 text-xs text-on-surface-variant"
          >
            {status}
          </p>
        )}
        {matches.map((option, position) => {
          const path = option.kind === "file" || option.kind === "folder";
          return (
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
                <span className="min-w-0 truncate font-mono">
                  {path
                    ? `${option.name}${option.kind === "folder" ? "/" : ""}`
                    : (option.token ?? `/${option.name}`)}
                </span>
                {option.title && (
                  <span className="min-w-0 flex-1 basis-0 truncate text-on-surface-variant">
                    {option.title}
                  </span>
                )}
                <span className="ml-auto max-w-[40%] shrink-0 truncate rounded px-1.5 text-xs text-on-surface-variant ring-1 ring-border">
                  {option.source ?? option.kind}
                </span>
              </span>
              {option.description && (
                <span className="w-full truncate text-xs text-on-surface-variant">
                  {option.description}
                </span>
              )}
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
