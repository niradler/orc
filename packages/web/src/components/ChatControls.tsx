import { ChatModelSchema } from "@orc/core/chat";
import type { ArchiveSession } from "@orc/core/session-archive";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  CircleAlert,
  CircleDot,
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
import { type ChatHistoryEntry, chatHistoryList, mergeHistoryState } from "@/lib/chat-history-list";

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
  const [visibleCount, setVisibleCount] = useState(50);
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
  const entries = chatHistoryList(
    chat.tabs,
    threads.data?.threads ?? [],
    live.data?.sessions ?? [],
    archive.data?.sessions ?? [],
    search,
  );
  const loading = threads.isLoading || live.isLoading || archive.isLoading;
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
          <Button
            variant="ghost"
            className="w-full justify-start"
            data-testid="chat-history-new"
            disabled={pending}
            onClick={() => {
              chat.newTab();
              setOpen(false);
            }}
          >
            New conversation
          </Button>
          <Input
            data-testid="chat-session-search"
            aria-label="Search conversations"
            placeholder="Search conversations…"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setVisibleCount(50);
            }}
          />
          <div data-testid="chat-session-list" className="min-w-0 space-y-1">
            {entries.slice(0, visibleCount).map((entry) => (
              <HistoryRow
                key={entry.id}
                entry={entry}
                pending={pending}
                onLocalSelect={() => setOpen(false)}
                onSavedSelect={(id) => void select(() => api.chat.get(id))}
                onNativeSelect={(id) => void select(() => api.chat.resume(id))}
                onArchiveSelect={(session) => {
                  setSelectedArchive(session);
                  setRepository(session.metadata.repository ?? "");
                  setBranch(session.metadata.branch ?? "");
                  setCommit(session.metadata.commit ?? "");
                  setSubdirectory(session.metadata.subdirectory ?? "");
                  setError("");
                }}
              />
            ))}
          </div>
          {loading && (
            <p role="status" className="px-2 text-xs text-muted-foreground">
              Loading sessions…
            </p>
          )}
          {!loading && !entries.length && (
            <p className="px-2 text-sm text-muted-foreground">
              {search ? "No sessions match." : "No conversations yet."}
            </p>
          )}
          {entries.length > visibleCount && (
            <Button
              variant="ghost"
              data-testid="chat-history-more"
              onClick={() => setVisibleCount((count) => count + 50)}
            >
              Load older sessions
            </Button>
          )}
        </>
      )}
      {(error || threads.error || live.error || archive.error) && (
        <p role="alert" className="text-sm text-error wrap-break-word">
          {error || threads.error?.message || live.error?.message || archive.error?.message}
        </p>
      )}
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

type SessionState = "idle" | "open" | "running" | "waiting" | "attention" | "error";
function HistoryRow({
  entry,
  pending,
  onLocalSelect,
  onSavedSelect,
  onNativeSelect,
  onArchiveSelect,
}: {
  entry: ChatHistoryEntry;
  pending: boolean;
  onLocalSelect: () => void;
  onSavedSelect: (id: string) => void;
  onNativeSelect: (id: string) => void;
  onArchiveSelect: (session: ArchiveSession) => void;
}) {
  const chat = useChat();
  const tab = entry.kind === "local" ? entry.tab : null;
  const selected = tab?.key === chat.activeKey;
  const open = !!tab && !tab.hidden;
  const localState: SessionState = tab
    ? tab.permissions.length || tab.questions.length
      ? "waiting"
      : tab.error
        ? "error"
        : tab.streaming
          ? "running"
          : tab.attention
            ? "attention"
            : open
              ? "open"
              : "idle"
    : entry.kind === "saved"
      ? entry.thread.running
        ? "running"
        : "idle"
      : entry.kind === "native"
        ? entry.session.waiting_for_human
          ? "waiting"
          : entry.session.status === "running"
            ? "running"
            : entry.session.status === "idle"
              ? "open"
              : entry.session.status === "error"
                ? "error"
                : "idle"
        : "idle";
  const state = mergeHistoryState(localState, entry.observedState ?? "idle");
  const agent =
    tab?.config.agent ||
    (entry.kind === "native" || entry.kind === "archive" ? entry.session.agent : "");
  const status = {
    idle: "Saved conversation",
    open: "Open session",
    running: "Working",
    waiting: "Needs your input",
    attention: "New response",
    error: "Error",
  }[state];
  const liveBusy = entry.kind === "native" && ["running", "idle"].includes(entry.session.status);
  const selectRow = () => {
    if (entry.kind === "local") {
      chat.selectTab(entry.tab.key);
      onLocalSelect();
    } else if (entry.kind === "saved") onSavedSelect(entry.thread.id);
    else if (entry.kind === "native") onNativeSelect(entry.session.id);
    else onArchiveSelect(entry.session);
  };
  const Glyph =
    state === "running"
      ? LoaderCircle
      : state === "waiting" || state === "error"
        ? CircleAlert
        : state === "open" || state === "attention"
          ? CircleDot
          : MessageSquare;
  const testId =
    entry.kind === "local"
      ? "chat-session-select"
      : entry.kind === "saved"
        ? "chat-resume-thread"
        : entry.kind === "native"
          ? "chat-resume-live"
          : "chat-resume-archive";
  return (
    <div
      data-testid={tab ? "chat-tab" : "chat-history-row"}
      data-history-id={entry.id}
      data-history-updated={entry.updatedAt}
      data-history-kind={entry.kind}
      data-history-open={open ? "true" : "false"}
      data-active={selected ? "true" : "false"}
      data-state={state}
      className={`group flex min-w-0 items-center rounded-md ${selected ? "bg-surface-highest" : "hover:bg-surface"}`}
    >
      <button
        type="button"
        data-testid={testId}
        aria-current={selected ? "true" : undefined}
        disabled={pending || liveBusy}
        title={
          entry.title +
          "\n" +
          [
            agent,
            status,
            entry.updatedAt ? new Date(entry.updatedAt).toLocaleString() : "",
            liveBusy ? "End the original agent before resuming here." : "",
          ]
            .filter(Boolean)
            .join(" · ")
        }
        onClick={selectRow}
        className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left disabled:opacity-60"
      >
        <Glyph
          data-testid="chat-session-status"
          data-state={state}
          role="img"
          aria-label={status}
          size={15}
          className={`shrink-0 ${state === "waiting" ? "text-warning" : state === "error" ? "text-error" : state === "running" ? "animate-spin text-progress" : state === "open" || state === "attention" ? "text-progress" : "text-muted-foreground"}`}
        />
        <span className="min-w-0 flex-1 truncate text-[13px]">{entry.title}</span>
        <span className="sr-only">
          {agent ? ` · ${agent}` : ""}
          {tab?.draft ? " · Draft" : ""}
          {liveBusy
            ? " · End the original agent before resuming here."
            : entry.kind === "archive"
              ? " · Import and resume"
              : ""}
        </span>
        {entry.kind === "saved" && entry.thread.running && (
          <span data-testid="chat-thread-running" className="sr-only">
            Running
          </span>
        )}
      </button>
      {open && tab && (
        <button
          type="button"
          data-testid="chat-tab-close"
          aria-label={`Close ${entry.title} from open sessions`}
          title="Close from open sessions; history and background work are kept"
          onClick={() => chat.closeTab(tab.key)}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100 max-md:opacity-100"
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
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
