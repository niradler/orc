import { ChatModelSchema } from "@orc/core/chat";
import type { ArchiveSession } from "@orc/core/session-archive";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  CircleAlert,
  History,
  LoaderCircle,
  MessageSquare,
  PanelLeftClose,
  Settings2,
  X,
} from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { api } from "@/api/client";
import { ChatAgentOptionsEditor } from "@/components/ChatAgentOptionsEditor";
import { ChatPermissionSelect } from "@/components/ChatPermissionSelect";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useChat } from "@/hooks/useChat";
import { useSsh } from "@/hooks/useSsh";

export function ChatSessionPicker({
  docked = false,
  onCollapse,
  onExpand,
}: {
  docked?: boolean;
  onCollapse?: () => void;
  onExpand?: () => void;
}) {
  const chat = useChat();
  const [dialogOpen, setOpen] = useState(false);
  const open = docked || dialogOpen;
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const [selectedArchive, setSelectedArchive] = useState<ArchiveSession | null>(null);
  const [repository, setRepository] = useState("");
  const [branch, setBranch] = useState("");
  const [commit, setCommit] = useState("");
  const [subdirectory, setSubdirectory] = useState("");
  const threads = useQuery({
    queryKey: ["chat-threads", open],
    queryFn: api.chat.list,
    enabled: open,
    staleTime: 0,
  });
  const live = useQuery({
    queryKey: ["chat-resume-sessions", open],
    queryFn: () => api.sessions.live({ active: false, limit: 5000 }),
    enabled: open,
    staleTime: 0,
  });
  const archive = useQuery({
    queryKey: ["chat-resume-archive", search],
    queryFn: () => api.sessions.archive({ q: search, limit: 30 }),
    enabled: open,
  });
  async function select(load: () => ReturnType<typeof api.chat.get>) {
    setPending(true);
    setError("");
    try {
      chat.openThread(await load());
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Session could not be opened.");
    } finally {
      setPending(false);
    }
  }
  const matches = (value: string) => value.toLowerCase().includes(search.toLowerCase());
  return (
    <SessionHistoryFrame
      docked={docked}
      open={dialogOpen}
      onOpenChange={setOpen}
      onCollapse={onCollapse}
      onExpand={onExpand}
    >
      {selectedArchive ? (
        <section className="min-w-0 space-y-3">
          <Button variant="ghost" disabled={pending} onClick={() => setSelectedArchive(null)}>
            Back to conversations
          </Button>
          <h3 className="font-medium wrap-break-word">{selectedArchive.title}</h3>
          <p className="text-sm text-muted-foreground">
            Resume from a pushed repository, branch and exact commit. ORC verifies the checkout and
            imports the native history before opening chat.
          </p>
          {(
            [
              ["repository", "Repository", repository, setRepository],
              ["branch", "Branch", branch, setBranch],
              ["commit", "Pushed commit", commit, setCommit],
              ["subdirectory", "Repository subdirectory", subdirectory, setSubdirectory],
            ] as const
          ).map(([key, title, value, change]) => (
            <label key={key} htmlFor={`chat-archive-${key}`} className="block space-y-2 text-sm">
              {title}
              <Input
                id={`chat-archive-${key}`}
                data-testid={`chat-archive-${key}`}
                value={value}
                onChange={(event) => change(event.target.value)}
                disabled={pending}
              />
            </label>
          ))}
          <Button
            data-testid="chat-archive-prepare"
            disabled={pending || !repository || !branch || !/^[a-f0-9]{40}$/i.test(commit)}
            onClick={() =>
              void select(async () => {
                const handoff = await api.sessions.archiveResume(selectedArchive.id, {
                  revision: selectedArchive.revision,
                  repository,
                  branch,
                  commit,
                  subdirectory,
                });
                if (handoff.status !== "ready" || !handoff.live_session_id)
                  throw new Error(handoff.error || "The imported session is not ready to resume.");
                return api.chat.resume(handoff.live_session_id);
              })
            }
          >
            {pending ? "Preparing…" : "Prepare and resume in chat"}
          </Button>
        </section>
      ) : (
        <>
          <Input
            data-testid="chat-session-search"
            aria-label="Search conversations"
            placeholder="Search conversations…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="min-w-0 space-y-4">
            <OpenChatSessions search={search} onSelect={() => setOpen(false)} />
            <details open={search ? true : undefined}>
              <summary
                data-testid="chat-earlier-toggle"
                className="min-h-8 cursor-pointer text-xs text-muted-foreground"
              >
                Earlier conversations
                {chat.tabs.some(
                  (tab) =>
                    tab.hidden && (tab.permissions.length || tab.questions.length || tab.error),
                ) && <span className="ml-2 text-warning">Needs attention</span>}
              </summary>
              <ClosedChatSessions search={search} onSelect={() => setOpen(false)} />
              {threads.data?.threads
                .filter(
                  (t) => matches(t.title) && !chat.tabs.some((tab) => tab.thread?.id === t.id),
                )
                .slice(0, 50)
                .map((t) => (
                  <button
                    key={t.id}
                    data-testid="chat-resume-thread"
                    type="button"
                    disabled={pending}
                    className="flex min-h-8 w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-surface"
                    onClick={() => void select(() => api.chat.get(t.id))}
                  >
                    <span className="min-w-0 flex-1 truncate">{t.title}</span>
                    {t.running && (
                      <span
                        data-testid="chat-thread-running"
                        className="flex shrink-0 items-center gap-1 text-xs text-primary"
                      >
                        <LoaderCircle size={12} aria-hidden="true" className="animate-spin" />
                        Running
                      </span>
                    )}
                  </button>
                ))}
              {threads.isLoading && (
                <p role="status" className="text-sm text-muted-foreground">
                  Loading chats…
                </p>
              )}
              {!threads.isLoading && !threads.data?.threads.length && (
                <p className="text-sm text-muted-foreground">
                  Your conversations will appear here.
                </p>
              )}
            </details>
            <details open={search ? true : undefined}>
              <summary
                data-testid="chat-native-toggle"
                className="min-h-8 cursor-pointer text-xs text-muted-foreground"
              >
                Coding agent sessions
              </summary>
              <p className="my-2 text-xs text-muted-foreground">
                End the original agent before resuming it here.
              </p>
              {live.data?.sessions
                .filter(
                  (s) =>
                    ["claude", "codex"].includes(s.agent) &&
                    matches(`${s.name ?? ""} ${s.cwd ?? ""}`),
                )
                .slice(0, 50)
                .map((s) => (
                  <button
                    key={s.id}
                    data-testid="chat-resume-live"
                    type="button"
                    disabled={pending || s.status === "running" || s.status === "idle"}
                    className="block min-h-8 w-full rounded-md px-3 py-2 text-left text-sm hover:bg-surface disabled:opacity-40"
                    onClick={() => void select(() => api.chat.resume(s.id))}
                  >
                    <span className="block truncate">{s.name || s.session_id || "Session"}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {s.agent} · {s.status} · {s.cwd}
                    </span>
                  </button>
                ))}
            </details>
            <details open={search ? true : undefined}>
              <summary
                data-testid="chat-synced-toggle"
                className="min-h-8 cursor-pointer text-xs text-muted-foreground"
              >
                Synced sessions
              </summary>
              {archive.data?.sessions
                .filter((s) => ["claude", "codex"].includes(s.agent))
                .map((s) => (
                  <button
                    type="button"
                    data-testid="chat-resume-archive"
                    key={s.id}
                    disabled={pending}
                    className="block min-h-8 w-full rounded-md px-3 py-2 text-left text-sm hover:bg-surface disabled:opacity-40"
                    onClick={() => {
                      setSelectedArchive(s);
                      setRepository(s.metadata.repository ?? "");
                      setBranch(s.metadata.branch ?? "");
                      setCommit(s.metadata.commit ?? "");
                      setSubdirectory(s.metadata.subdirectory ?? "");
                      setError("");
                    }}
                  >
                    <span className="block truncate">{s.title || s.native_id}</span>
                    <span className="text-xs text-muted-foreground">
                      {s.agent} · Import and resume
                    </span>
                  </button>
                ))}
            </details>
          </div>
        </>
      )}
      {(error || threads.error || live.error || archive.error) && (
        <p role="alert" className="text-sm text-error wrap-break-word">
          {error || threads.error?.message || live.error?.message || archive.error?.message}
        </p>
      )}
      <Button
        variant="outline"
        disabled={pending}
        onClick={() => {
          chat.newTab();
          setOpen(false);
        }}
      >
        New conversation
      </Button>
    </SessionHistoryFrame>
  );
}

function SessionHistoryFrame({
  docked,
  open,
  onOpenChange,
  onCollapse,
  onExpand,
  children,
}: {
  docked: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCollapse?: () => void;
  onExpand?: () => void;
  children: ReactNode;
}) {
  const chat = useChat();
  const pending = chat.tabs.filter(
    (tab) =>
      tab.key !== chat.activeKey &&
      (tab.permissions.length || tab.questions.length || tab.attention || tab.error),
  ).length;
  const content = useRef<HTMLDivElement>(null);
  const trigger = (
    <button
      type="button"
      data-testid="chat-sessions-button"
      aria-label={
        pending ? `Sessions, ${pending} need attention` : "Sessions, conversation history"
      }
      title="Session history"
      className="absolute left-2 top-1 z-10 inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-surface"
      onClick={onExpand}
    >
      <History size={16} />
      <span>Sessions</span>
      {pending > 0 && <span className="rounded bg-surface px-1 text-warning">{pending}</span>}
    </button>
  );
  if (docked)
    return (
      <aside
        data-testid="chat-session-sidebar"
        className="flex w-64 shrink-0 flex-col border-r border-border px-3 py-3"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="px-2 text-sm font-medium">Sessions</h2>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Collapse session history"
            onClick={onCollapse}
          >
            <PanelLeftClose size={16} />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto space-y-4">{children}</div>
      </aside>
    );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {onExpand ? trigger : <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent
        ref={content}
        data-testid="chat-sessions-dialog"
        className="chat-history-drawer left-0 top-[var(--app-top,0px)] flex h-[var(--app-height,100dvh)] w-[min(340px,calc(100vw-24px))] max-h-none max-w-none translate-x-0 translate-y-0 flex-col gap-4 rounded-none p-4"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          content.current?.focus();
        }}
      >
        <DialogTitle>Session history</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  );
}

function SessionRows({
  closed = false,
  search = "",
  onSelect,
}: {
  closed?: boolean;
  search?: string;
  onSelect: () => void;
}) {
  const chat = useChat();
  const tabs = chat.tabs.filter(
    (tab) =>
      Boolean(tab.hidden) === closed &&
      `${tab.thread?.title || "New conversation"} ${tab.config.agent}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <div data-testid={closed ? "chat-closed-sessions" : "chat-open-sessions"} className="space-y-1">
      {tabs.map((tab) => {
        const waiting = tab.permissions.length > 0 || tab.questions.length > 0;
        const state = waiting
          ? "waiting"
          : tab.error
            ? "error"
            : tab.streaming
              ? "running"
              : tab.attention
                ? "attention"
                : "idle";
        const title = tab.thread?.title || "New conversation";
        return (
          <div
            key={tab.key}
            data-testid="chat-tab"
            data-active={tab.key === chat.activeKey ? "true" : "false"}
            data-state={state}
            className={`group flex min-w-0 items-center rounded-md ${tab.key === chat.activeKey ? "bg-surface-highest" : "hover:bg-surface"}`}
          >
            <button
              type="button"
              data-testid="chat-session-select"
              aria-current={tab.key === chat.activeKey ? "true" : undefined}
              onClick={() => {
                chat.selectTab(tab.key);
                onSelect();
              }}
              className="flex min-h-12 min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left"
            >
              {waiting ? (
                <CircleAlert
                  size={15}
                  className="shrink-0 text-warning"
                  aria-label="Needs your input"
                />
              ) : tab.error ? (
                <CircleAlert size={15} className="shrink-0 text-error" aria-label="Error" />
              ) : tab.streaming ? (
                <LoaderCircle
                  size={15}
                  className="shrink-0 animate-spin text-progress"
                  aria-label="Working"
                />
              ) : (
                <MessageSquare size={15} className="shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px]">{title}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {tab.config.agent}
                  {waiting
                    ? " · Needs your input"
                    : tab.error
                      ? " · Error"
                      : tab.streaming
                        ? " · Working"
                        : tab.attention
                          ? " · New response"
                          : ""}
                  {tab.draft ? " · Draft" : ""}
                </span>
              </span>
              {tab.key === chat.activeKey && <Check size={12} className="shrink-0" />}
            </button>
            {!closed && (
              <button
                type="button"
                data-testid="chat-tab-close"
                aria-label={`Close ${title} from open sessions`}
                title="Close from open sessions; history and background work are kept"
                onClick={() => chat.closeTab(tab.key)}
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
              >
                <X size={13} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
function OpenChatSessions({ search, onSelect }: { search: string; onSelect: () => void }) {
  const chat = useChat();
  return (
    <section>
      <h3 className="mb-2 flex justify-between px-2 text-xs text-muted-foreground">
        <span>Open sessions</span>
        <span>{chat.tabs.filter((tab) => !tab.hidden).length}</span>
      </h3>
      <SessionRows search={search} onSelect={onSelect} />
    </section>
  );
}
function ClosedChatSessions({ search, onSelect }: { search: string; onSelect: () => void }) {
  return <SessionRows closed search={search} onSelect={onSelect} />;
}

export function ChatAgentPicker() {
  const chat = useChat();
  const [open, setOpen] = useState(false);
  const agents = Array.from(new Set(["codex", "claude", "gemini", "copilot", chat.config.agent]));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="chat-agent-button"
          aria-label={`Choose agent, current ${chat.config.agent}`}
          disabled={!chat.ready}
          className="inline-flex min-h-8 min-w-0 max-w-36 items-center gap-1 rounded-md px-2 text-[13px] hover:bg-surface-highest"
        >
          <span className="truncate">{chat.config.agent}</span>
          <ChevronDown size={12} className="shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        aria-label="Choose agent"
        side="top"
        align="start"
        className="w-72 max-w-[calc(100vw-2rem)] space-y-3"
      >
        <h2 className="text-sm font-medium">Choose agent</h2>
        {chat.thread && (
          <p className="text-xs text-muted-foreground">
            Changing agents starts a new conversation. This session is kept in history.
          </p>
        )}
        <label className="block text-xs text-muted-foreground">
          Agent
          <select
            data-testid="chat-agent-select"
            aria-label="Chat agent"
            value={chat.config.agent}
            className="form-control form-control-single mt-2"
            onChange={(event) => {
              const agent = event.target.value;
              if (chat.thread || chat.streaming) chat.startAgentConversation(agent);
              else chat.setConfig({ ...chat.config, agent, model: "" });
              setOpen(false);
            }}
          >
            {agents.map((agent) => (
              <option key={agent} value={agent}>
                {agent}
              </option>
            ))}
          </select>
        </label>
      </PopoverContent>
    </Popover>
  );
}

export function ChatModelPicker() {
  const { config, setConfig, streaming, thread, ready } = useChat();
  const { data: ssh } = useSsh();
  const [custom, setCustom] = useState(false);
  const [model, setModel] = useState("");
  const [error, setError] = useState("");
  const catalog = useQuery({
    queryKey: ["chat-models", config.agent, thread?.id, thread ? thread.host : ssh?.host],
    queryFn: () => api.chat.models(config.agent, thread?.id),
    enabled: ready,
    staleTime: 120_000,
    retry: false,
  });
  const choices = new Map((catalog.data?.models ?? []).map((model) => [model.id, model.label]));
  for (const model of config.models.filter((model) => model.agent === config.agent))
    if (!choices.has(model.id)) choices.set(model.id, model.id);
  if (config.model && !choices.has(config.model)) choices.set(config.model, config.model);
  const warning = catalog.isError
    ? "Models could not be loaded. Saved and custom models are available."
    : catalog.data?.warning;
  return (
    <div className="min-w-0">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="chat-model-button"
            aria-label={`Choose model, current ${choices.get(config.model) || config.model || "Agent default"}`}
            disabled={streaming || !ready}
            title={streaming ? "Available after the current response" : "Choose model"}
            className="inline-flex min-h-8 max-w-48 min-w-0 items-center gap-1 rounded-md px-2 text-[13px] text-muted-foreground hover:bg-surface-highest disabled:opacity-50"
          >
            <span className="truncate">
              {choices.get(config.model) || config.model || "Agent default"}
            </span>
            <ChevronDown size={12} className="shrink-0" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          aria-label="Choose model"
          side="top"
          align="start"
          className="w-80 max-w-[calc(100vw-2rem)] space-y-3"
        >
          <h2 className="text-sm font-medium">Choose model</h2>
          <label className="block min-w-0">
            <span className="sr-only">Model</span>
            <select
              data-testid="chat-model-select"
              aria-label="Chat model"
              title={catalog.isFetching ? "Loading models…" : config.model || "Agent default"}
              value={custom ? "__custom__" : config.model}
              disabled={streaming || !ready}
              onChange={(event) => {
                setError("");
                const value = event.target.value;
                setCustom(value === "__custom__");
                if (value === "__custom__") setModel(config.model);
                else setConfig({ ...config, model: value });
              }}
              className="min-h-8 w-full min-w-0 rounded-md border border-control-border bg-background px-2 text-base sm:text-sm text-on-surface disabled:opacity-50"
            >
              <option value="">Agent default</option>
              {[...choices].map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
              <option value="__custom__">Custom model…</option>
            </select>
          </label>
          {custom && (
            <form
              className="mt-2 flex min-w-0 gap-1"
              onSubmit={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const parsed = ChatModelSchema.safeParse(model);
                if (!parsed.success) {
                  setError("Enter a valid model ID (up to 200 characters).");
                  return;
                }
                setConfig({ ...config, model: parsed.data });
                setCustom(false);
              }}
            >
              <Input
                data-testid="chat-custom-model"
                aria-label="Custom model ID"
                value={model}
                disabled={streaming}
                onChange={(event) => setModel(event.target.value)}
                className="min-w-0"
              />
              <Button
                type="submit"
                data-testid="chat-custom-model-apply"
                disabled={streaming}
                className="min-h-8 px-2"
              >
                Use
              </Button>
            </form>
          )}
        </PopoverContent>
      </Popover>
      {(error || warning) && (
        <p
          data-testid="chat-model-warning"
          role={error ? "alert" : "status"}
          className="mt-1 text-xs text-on-surface-variant wrap-break-word"
        >
          {error || warning}
        </p>
      )}
    </div>
  );
}

export function ChatConversationInfo() {
  const { config, changePermissions, thread } = useChat();
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          data-testid="chat-config-button"
          aria-label="Conversation settings"
          title="Conversation settings"
          className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface"
        >
          <Settings2 size={17} />
        </button>
      </DialogTrigger>
      <DialogContent data-testid="chat-config-dialog" className="w-[calc(100%-1rem)]">
        <DialogTitle>Conversation settings</DialogTitle>
        <DialogDescription>
          Loosening permissions applies right away, including to a pending approval. Stricter
          permissions apply to your next message. Change new-chat defaults in Settings.
        </DialogDescription>
        <dl className="space-y-3 text-sm wrap-break-word">
          <div>
            <dt className="text-muted-foreground">Agent and working folder</dt>
            <dd>
              {config.agent} · {thread?.host || "Selected execution host"}
              {thread?.cwd && <span className="block font-mono text-xs">{thread.cwd}</span>}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Tools</dt>
            <dd>
              {config.mcp === "orc"
                ? "ORC MCP connection plus agent host configuration"
                : "Agent host configuration"}
            </dd>
          </div>
          <div>
            <dd>
              <ChatPermissionSelect
                config={config}
                onChange={(next) => void changePermissions(next)}
              />
            </dd>
          </div>
        </dl>
        <ChatAgentOptionsEditor key={`${config.agent}:${thread?.id ?? "new"}`} />
        <details className="text-sm">
          <summary className="min-h-11 cursor-pointer py-3">Conversation instructions</summary>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap wrap-break-word text-xs">
            {config.system || "No additional instructions"}
          </pre>
          <p className="mt-2 text-xs text-muted-foreground">
            {config.agent === "claude"
              ? "Appended to Claude’s coding system prompt."
              : "Sent as turn instructions to the agent."}{" "}
            Agent and workspace instructions may also apply.
          </p>
        </details>
      </DialogContent>
    </Dialog>
  );
}
