import { Check, FolderOpen, GitBranch, History, LoaderCircle, Monitor } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, getApiUrl } from "@/api/client";
import { ActionHelp } from "@/components/ActionHelp";
import { FolderPickerDialog } from "@/components/FolderPickerDialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useChat } from "@/hooks/useChat";
import { useSsh } from "@/hooks/useSsh";
import { folderHistory, rememberFolder, useFolderHistory } from "@/lib/folder-history";
import { cn } from "@/lib/utils";

const iconButton =
  "inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-highest hover:text-on-surface focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-40 sm:size-8 [@media(pointer:coarse)]:size-11";
const optionButton =
  "flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-surface-highest focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-40";

export function ChatWorkspaceControls() {
  const {
    workspace,
    setWorkspace,
    thread,
    streaming,
    activeKey,
    workspacePickerOpen: browse,
    setWorkspacePickerOpen: setBrowse,
    openWorkspacePicker,
    workspacePickerSession,
  } = useChat();
  const { data: ssh } = useSsh();
  const [hostOpen, setHostOpen] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState("");
  const [pathDraft, setPathDraft] = useState<string | null>(null);
  const host = workspace?.host === undefined ? (ssh?.host ?? null) : workspace.host;
  const history = useFolderHistory(host);
  const cwd = workspace?.cwd ?? history.last;
  const worktree = workspace?.worktree ?? false;
  const disabled = streaming || !ssh || picking;
  const current = useRef({ host, thread, streaming, activeKey });
  const mounted = useRef(true);
  const folderTrigger = useRef<HTMLButtonElement>(null);
  const previousConversation = useRef(activeKey);
  current.current = { host, thread, streaming, activeKey };
  useEffect(() => {
    if (previousConversation.current === activeKey) return;
    previousConversation.current = activeKey;
    setHostOpen(false);
    setRecentOpen(false);
    setBrowse(false);
    setPathDraft(null);
    setError("");
  }, [activeKey, setBrowse]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (ssh && !workspace && !thread && !streaming)
      setWorkspace({ host: ssh.host, cwd: folderHistory(ssh.host).last, worktree: false });
  }, [ssh, workspace, thread, streaming, setWorkspace]);
  if (thread) return null;

  const choose = (path: string) => {
    setWorkspace({ host, cwd: path, worktree: worktree && !!path.trim() });
    rememberFolder(host, path);
    setPathDraft(null);
    setError("");
  };
  const pick = async () => {
    setError("");
    let localApi = false;
    try {
      const hostname = new URL(getApiUrl(), window.location.href).hostname;
      localApi = ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
    } catch {
      /* Invalid API settings cannot open a native dialog. */
    }
    if (host !== null || !localApi) {
      openWorkspacePicker(cwd);
      return;
    }
    const selectedHost = host;
    const selectedConversation = activeKey;
    setPicking(true);
    try {
      const result = await api.terminals.pickFolder(cwd || undefined, selectedHost);
      if (
        mounted.current &&
        result.path &&
        current.current.host === selectedHost &&
        current.current.activeKey === selectedConversation &&
        !current.current.thread &&
        !current.current.streaming
      )
        choose(result.path);
    } catch (problem) {
      if (
        !mounted.current ||
        current.current.thread ||
        current.current.activeKey !== selectedConversation
      )
        return;
      const message =
        problem instanceof Error ? problem.message : "Could not open the folder picker.";
      if (message.includes("No folder picker is available on this machine"))
        openWorkspacePicker(cwd);
      else setError(message);
    } finally {
      setPicking(false);
    }
  };
  const folderParts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  const folderName = folderParts[folderParts.length - 1] || cwd || "Default folder";
  return (
    <div data-testid="chat-workspace" className="chat-workspace-controls min-w-0">
      <fieldset
        data-testid="chat-workspace-actions"
        aria-label="Workspace controls"
        className="chat-workspace-actions flex min-w-0 flex-wrap items-center gap-0.5"
      >
        <Popover open={hostOpen} onOpenChange={setHostOpen}>
          <ActionHelp
            label="Choose workspace host"
            description={`Workspace host: ${host ?? "Local"}`}
          >
            <PopoverTrigger asChild>
              <button
                type="button"
                data-testid="chat-workspace-host"
                aria-label={`Choose workspace host, current ${host ?? "Local"}`}
                disabled={disabled}
                className={iconButton}
              >
                <Monitor size={16} />
              </button>
            </PopoverTrigger>
          </ActionHelp>
          <PopoverContent side="top" align="start" className="w-64 p-2" aria-label="Workspace host">
            <p className="px-2 py-1 text-xs text-muted-foreground">Workspace host</p>
            {[null, ...new Set([...(ssh?.hosts ?? []), ...(ssh?.host ? [ssh.host] : [])])].map(
              (alias) => (
                <button
                  type="button"
                  key={alias ?? "local"}
                  data-testid="chat-workspace-host-option"
                  aria-pressed={host === alias}
                  disabled={disabled}
                  className={optionButton}
                  onClick={() => {
                    const nextCwd = folderHistory(alias).last;
                    setWorkspace({
                      host: alias,
                      cwd: nextCwd,
                      worktree: worktree && !!nextCwd.trim(),
                    });
                    setHostOpen(false);
                    setBrowse(false);
                    setPathDraft(null);
                    setError("");
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{alias ?? "Local"}</span>
                  {host === alias && <Check size={14} />}
                </button>
              ),
            )}
          </PopoverContent>
        </Popover>
        <ActionHelp
          label="Browse workspace folder"
          description={`Choose folder on ${host ?? "Local"}: ${cwd || "Default folder"}`}
        >
          <button
            type="button"
            data-testid="chat-workspace-browse"
            ref={folderTrigger}
            aria-label={`Browse workspace folder, current ${host ?? "Local"}: ${cwd || "Default folder"}`}
            disabled={disabled}
            onClick={() => void pick()}
            className={iconButton}
          >
            {picking ? (
              <LoaderCircle size={16} className="animate-spin" />
            ) : (
              <FolderOpen size={16} />
            )}
          </button>
        </ActionHelp>
        <Popover open={recentOpen} onOpenChange={setRecentOpen}>
          <ActionHelp label="Recent workspace folders">
            <PopoverTrigger asChild>
              <button
                type="button"
                data-testid="chat-workspace-recent"
                aria-label="Recent workspace folders"
                disabled={disabled}
                className={iconButton}
              >
                <History size={16} />
              </button>
            </PopoverTrigger>
          </ActionHelp>
          <PopoverContent
            side="top"
            align="start"
            className="w-80 p-2"
            aria-label="Recent workspace folders"
          >
            <p className="px-2 py-1 text-xs text-muted-foreground">
              Recent folders · {host ?? "Local"}
            </p>
            <div data-testid="recent-folders" className="max-h-48 overflow-y-auto">
              {history.recent.map((path) => (
                <button
                  type="button"
                  key={path}
                  data-testid="chat-workspace-recent-option"
                  title={path}
                  disabled={disabled}
                  className={optionButton}
                  onClick={() => {
                    choose(path);
                    setRecentOpen(false);
                  }}
                >
                  <span className="min-w-0 truncate">{path}</span>
                </button>
              ))}
              {!history.recent.length && (
                <p className="px-2 py-3 text-sm text-muted-foreground">No recent folders</p>
              )}
            </div>
            <div className="mt-2 space-y-2 border-t border-border pt-2">
              <label
                htmlFor="chat-workspace-folder"
                className="block px-2 text-xs text-muted-foreground"
              >
                Folder path
              </label>
              <Input
                id="chat-workspace-folder"
                data-testid="chat-workspace-cwd"
                maxLength={4096}
                value={pathDraft ?? cwd}
                disabled={disabled}
                onChange={(event) => setPathDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    choose((pathDraft ?? cwd).trim());
                    setRecentOpen(false);
                  }
                }}
              />
              <button
                type="button"
                data-testid="chat-workspace-apply"
                disabled={disabled}
                className={optionButton}
                onClick={() => {
                  choose((pathDraft ?? cwd).trim());
                  setRecentOpen(false);
                }}
              >
                Apply folder
              </button>
            </div>
          </PopoverContent>
        </Popover>
        <ActionHelp
          label="New git worktree"
          description={
            worktree
              ? "New git worktree enabled"
              : "Create a new git worktree for this conversation"
          }
        >
          <button
            type="button"
            data-testid="chat-workspace-worktree"
            aria-label="New git worktree"
            aria-pressed={worktree}
            disabled={disabled || !cwd.trim()}
            onClick={() => setWorkspace({ host, cwd, worktree: !worktree })}
            className={cn(
              iconButton,
              worktree &&
                !disabled &&
                !!cwd.trim() &&
                "bg-surface-highest text-progress hover:text-progress",
            )}
          >
            <GitBranch size={16} />
          </button>
        </ActionHelp>
        <span
          data-testid="chat-workspace-path"
          title={`${host ?? "Local"}: ${cwd || "Default folder"}`}
          className="sr-only text-xs text-muted-foreground sm:not-sr-only sm:max-w-28 sm:truncate sm:px-1"
        >
          {folderName}
        </span>
      </fieldset>
      {picking && (
        <span role="status" className="basis-full px-2 text-xs text-muted-foreground">
          Choose a folder in the native dialog…
        </span>
      )}
      {error && (
        <div className="basis-full px-2 text-xs">
          <p role="alert" data-testid="chat-workspace-error" className="text-error wrap-break-word">
            {error}
          </p>
          <button
            type="button"
            disabled={disabled}
            onClick={() => openWorkspacePicker(cwd)}
            className="min-h-11 text-on-surface underline"
          >
            Browse folders here
          </button>
        </div>
      )}
      <FolderPickerDialog
        session={workspacePickerSession}
        open={browse}
        onOpenChange={setBrowse}
        host={host}
        initial={cwd}
        onPick={choose}
        returnFocusRef={folderTrigger}
      />
    </div>
  );
}
