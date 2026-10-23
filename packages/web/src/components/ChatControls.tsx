import { ChatSettingsSchema } from "@orc/core/chat";
import type { ArchiveSession } from "@orc/core/session-archive";
import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import { useRef, useState } from "react";
import { api } from "@/api/client";
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
  const { config, setConfig, streaming, thread } = useChat();
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState(config.model);
  const [error, setError] = useState("");
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) {
          setModel(config.model);
          setError("");
        }
      }}
    >
      <DialogTrigger asChild>
        <button
          data-testid="chat-model-button"
          type="button"
          disabled={streaming}
          className="min-h-11 min-w-0 max-w-[65%] truncate rounded-md px-2 text-xs text-on-surface-variant hover:bg-background disabled:opacity-40"
          title="Model and chat configuration"
        >
          {config.model || "Agent default"} ▾
        </button>
      </DialogTrigger>
      <DialogContent data-testid="chat-config-dialog" className="w-[calc(100%-1rem)]">
        <DialogTitle>Choose a model</DialogTitle>
        <DialogDescription>
          Use a model supported by your agent account. Edit new-chat defaults in Settings.
        </DialogDescription>
        <label htmlFor="chat-model-input" className="space-y-2 text-sm">
          Model
          <Input
            id="chat-model-input"
            data-testid="chat-model-input"
            aria-label="Chat model"
            list="chat-models"
            placeholder="Agent default"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
          <datalist id="chat-models">
            {config.models
              .filter((m) => m.agent === config.agent)
              .map((m) => (
                <option key={m.id} value={m.id} />
              ))}
          </datalist>
        </label>
        <fieldset className="flex min-w-0 flex-wrap gap-2" aria-label="Configured model choices">
          {[
            "",
            ...new Set(
              config.models.filter((item) => item.agent === config.agent).map((item) => item.id),
            ),
          ].map((value) => (
            <Button
              key={value || "default"}
              variant={model === value ? "secondary" : "outline"}
              aria-pressed={model === value}
              onClick={() => setModel(value)}
              className="max-w-full truncate"
            >
              {value || "Agent default"}
            </Button>
          ))}
        </fieldset>
        <details className="text-sm">
          <summary className="min-h-11 cursor-pointer py-3">Conversation setup</summary>
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
              <dt className="text-muted-foreground">Permissions</dt>
              <dd>
                {config.autoApprove
                  ? "Automatic agent actions"
                  : config.agent === "codex"
                    ? "Read-only sandbox"
                    : config.agent === "claude"
                      ? "Ask in chat"
                      : "Agent permission policy"}
              </dd>
            </div>
          </dl>
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
        </details>
        {error && (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        )}
        <Button
          data-testid="chat-model-apply"
          onClick={() => {
            const parsed = ChatSettingsSchema.safeParse({ ...config, model });
            if (!parsed.success) {
              setError("Use a model ID of at most 200 characters without control characters.");
              return;
            }
            setConfig(parsed.data);
            setOpen(false);
          }}
        >
          Apply model
        </Button>
      </DialogContent>
    </Dialog>
  );
}
