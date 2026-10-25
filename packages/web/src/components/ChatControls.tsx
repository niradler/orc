import { ChatModelSchema } from "@orc/core/chat";
import type { ArchiveSession } from "@orc/core/session-archive";
import { useQuery } from "@tanstack/react-query";
import { History, Settings2 } from "lucide-react";
import { useRef, useState } from "react";
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
import { useChat } from "@/hooks/useChat";
import { useSsh } from "@/hooks/useSsh";

export function ChatSessionPicker() {
  const chat = useChat();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const content = useRef<HTMLDivElement>(null);
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
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          data-testid="chat-sessions-button"
          disabled={chat.streaming}
          aria-label="Resume a conversation"
          title="Resume a conversation"
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface disabled:opacity-40"
        >
          <History size={17} />
        </button>
      </DialogTrigger>
      <DialogContent
        ref={content}
        data-testid="chat-sessions-dialog"
        className="w-[calc(100%-1rem)] gap-3"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          content.current?.focus();
        }}
      >
        <DialogTitle>Resume a conversation</DialogTitle>
        <DialogDescription>
          Continue a chat or an ended Claude or Codex session. End the original agent before
          resuming it here.
        </DialogDescription>
        {selectedArchive ? (
          <section className="min-w-0 space-y-3">
            <Button variant="ghost" disabled={pending} onClick={() => setSelectedArchive(null)}>
              Back to conversations
            </Button>
            <h3 className="font-medium break-words">{selectedArchive.title}</h3>
            <p className="text-sm text-muted-foreground">
              Resume from a pushed repository, branch and exact commit. ORC verifies the checkout
              and imports the native history before opening chat.
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
                    throw new Error(
                      handoff.error || "The imported session is not ready to resume.",
                    );
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
              <section>
                <h3 className="mb-2 text-sm font-medium">Chats</h3>
                {threads.data?.threads
                  .filter((t) => matches(t.title))
                  .slice(0, 50)
                  .map((t) => (
                    <button
                      key={t.id}
                      data-testid="chat-resume-thread"
                      type="button"
                      disabled={pending}
                      className="block min-h-11 w-full truncate rounded-md px-3 py-2 text-left text-sm hover:bg-surface"
                      onClick={() => void select(() => api.chat.get(t.id))}
                    >
                      {t.title}
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
              </section>
              <section>
                <h3 className="mb-2 text-sm font-medium">Coding agent sessions</h3>
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
                      className="block min-h-11 w-full rounded-md px-3 py-2 text-left text-sm hover:bg-surface disabled:opacity-40"
                      onClick={() => void select(() => api.chat.resume(s.id))}
                    >
                      <span className="block truncate">{s.name || s.session_id || "Session"}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {s.agent} · {s.status} · {s.cwd}
                      </span>
                    </button>
                  ))}
              </section>
              <section>
                <h3 className="mb-2 text-sm font-medium">Synced sessions</h3>
                {archive.data?.sessions
                  .filter((s) => ["claude", "codex"].includes(s.agent))
                  .map((s) => (
                    <button
                      type="button"
                      data-testid="chat-resume-archive"
                      key={s.id}
                      disabled={pending}
                      className="block min-h-11 w-full rounded-md px-3 py-2 text-left text-sm hover:bg-surface disabled:opacity-40"
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
              </section>
            </div>
          </>
        )}
        {(error || threads.error || live.error || archive.error) && (
          <p role="alert" className="text-sm text-error break-words">
            {error || threads.error?.message || live.error?.message || archive.error?.message}
          </p>
        )}
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => {
            chat.clear();
            setOpen(false);
          }}
        >
          New conversation
        </Button>
      </DialogContent>
    </Dialog>
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
          className="min-h-11 w-full min-w-0 rounded-md border border-control-border bg-background px-2 text-base sm:text-sm text-on-surface disabled:opacity-50"
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
            className="min-h-11 px-2"
          >
            Use
          </Button>
        </form>
      )}
      {(error || warning) && (
        <p
          data-testid="chat-model-warning"
          role={error ? "alert" : "status"}
          className="mt-1 text-xs text-on-surface-variant break-words"
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
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface"
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
        <dl className="space-y-3 text-sm break-words">
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
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">
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
