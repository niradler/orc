import { useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  Copy,
  Folder,
  FolderOpen,
  GitBranch,
  GitBranchPlus,
  LoaderCircle,
  Server,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, getApiUrl } from "@/api/client";
import {
  chipHeading,
  chipOption,
  composerChip,
  focusChipOption,
  onChipListKeyDown,
} from "@/components/ComposerChip";
import { FolderPickerDialog } from "@/components/FolderPickerDialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useChat } from "@/hooks/useChat";
import { useSsh } from "@/hooks/useSsh";
import {
  branchChipLabel,
  branchName,
  currentWorktree,
  folderChipLabel,
  pathName,
} from "@/lib/composer-chips";
import { folderHistory, rememberFolder, useFolderHistory } from "@/lib/folder-history";
import { cn } from "@/lib/utils";

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
  const [folderOpen, setFolderOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState("");
  const [pathDraft, setPathDraft] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const host = workspace?.host === undefined ? (ssh?.host ?? null) : workspace.host;
  const history = useFolderHistory(host);
  const cwd = workspace?.cwd ?? history.last;
  const defaultFolder = useQuery({
    queryKey: ["chat-default-folder", host],
    queryFn: () => api.terminals.browse(undefined, host),
    enabled: !!ssh && !cwd && !thread,
    staleTime: 60_000,
    retry: false,
  });
  const displayPath = cwd || defaultFolder.data?.path || "~";
  const gitPath = cwd || defaultFolder.data?.path || "";
  const git = useQuery({
    queryKey: ["chat-workspace-git", host, gitPath],
    queryFn: () => api.git.worktrees(gitPath, host),
    enabled: !!ssh && !!gitPath && !thread,
    staleTime: 30_000,
    retry: false,
  });
  const copied = copiedPath === displayPath;
  const worktree = workspace?.worktree ?? false;
  const disabled = streaming || !ssh || picking;
  const current = useRef({ host, thread, streaming, activeKey });
  const mounted = useRef(true);
  const folderTrigger = useRef<HTMLButtonElement>(null);
  const folderList = useRef<HTMLDivElement>(null);
  const branchList = useRef<HTMLDivElement>(null);
  const previousConversation = useRef(activeKey);
  current.current = { host, thread, streaming, activeKey };
  useEffect(() => {
    if (previousConversation.current === activeKey) return;
    previousConversation.current = activeKey;
    setFolderOpen(false);
    setBranchOpen(false);
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

  const hosts = [null, ...new Set([...(ssh?.hosts ?? []), ...(ssh?.host ? [ssh.host] : [])])];
  const listing = git.data;
  const folderName = cwd ? folderChipLabel(cwd, listing) : pathName(displayPath) || "Home";
  const folderLabel = host ? `${host} · ${folderName}` : folderName;
  const location = `${host ?? "Local"}: ${displayPath}`;
  const branch = branchName(currentWorktree(listing, gitPath));
  const showBranch = worktree || !!listing?.root || git.isError;

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
  const applyDraft = () => {
    choose((pathDraft ?? cwd).trim());
    setFolderOpen(false);
  };

  return (
    <fieldset
      data-testid="chat-workspace"
      aria-label="Workspace"
      className="chat-workspace-controls m-0 flex min-w-0 flex-wrap items-center gap-1 border-0 p-0"
    >
      <Popover open={folderOpen} onOpenChange={setFolderOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            ref={folderTrigger}
            data-testid="chat-workspace-folder"
            aria-label={`Workspace folder ${folderLabel}, ${location}`}
            title={location}
            disabled={disabled}
            className={cn(composerChip, "max-w-56")}
          >
            {picking ? (
              <LoaderCircle size={14} aria-hidden="true" className="shrink-0 animate-spin" />
            ) : host ? (
              <Server size={14} aria-hidden="true" className="shrink-0" />
            ) : (
              <Folder size={14} aria-hidden="true" className="shrink-0" />
            )}
            <span
              data-chip-label
              data-testid="chat-workspace-folder-name"
              className="min-w-0 truncate"
            >
              {folderLabel}
            </span>
            <ChevronDown
              data-chip-label
              size={12}
              aria-hidden="true"
              className="shrink-0 opacity-60"
            />
          </button>
        </PopoverTrigger>
        <PopoverContent
          data-testid="chat-workspace-folder-picker"
          aria-label="Workspace folder"
          side="top"
          align="start"
          className="w-80 p-1.5"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            focusChipOption(folderList.current, false);
          }}
          onKeyDown={onChipListKeyDown}
        >
          <div ref={folderList} className="space-y-1">
            <div className="flex min-w-0 items-start gap-1 px-2 pt-1">
              <span
                data-testid="chat-workspace-full-path"
                className="min-w-0 flex-1 self-center break-all font-mono text-xs text-on-surface-variant"
              >
                {displayPath}
              </span>
              <button
                type="button"
                data-chip-option
                data-testid="chat-workspace-copy-path"
                aria-label={copied ? "Folder path copied" : "Copy folder path"}
                title={copied ? "Folder path copied" : "Copy folder path"}
                disabled={!cwd && !defaultFolder.data?.path}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(displayPath);
                    setCopiedPath(displayPath);
                  } catch {
                    setError(
                      "Could not copy the folder path. Select and copy the full path above.",
                    );
                  }
                }}
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-highest hover:text-on-surface focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-40 max-sm:size-11 pointer-coarse:size-11"
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
            {hosts.length > 1 && (
              <div role="menu" aria-label="Workspace host">
                <p className={chipHeading}>Host</p>
                {hosts.map((alias) => (
                  <button
                    type="button"
                    key={alias ?? "local"}
                    role="menuitemradio"
                    data-chip-option
                    data-testid="chat-workspace-host-option"
                    aria-checked={host === alias}
                    disabled={disabled}
                    className={chipOption}
                    onClick={() => {
                      const nextCwd = folderHistory(alias).last;
                      setWorkspace({
                        host: alias,
                        cwd: nextCwd,
                        worktree: worktree && !!nextCwd.trim(),
                      });
                      setPathDraft(null);
                      setError("");
                    }}
                  >
                    {alias ? (
                      <Server size={14} aria-hidden="true" />
                    ) : (
                      <Folder size={14} aria-hidden="true" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{alias ?? "Local"}</span>
                    {host === alias && <Check size={14} aria-hidden="true" />}
                  </button>
                ))}
              </div>
            )}
            <div>
              <p className={chipHeading}>Recent folders</p>
              <div data-testid="recent-folders" className="max-h-48 overflow-y-auto">
                {history.recent.map((path) => (
                  <button
                    type="button"
                    key={path}
                    data-chip-option
                    data-testid="chat-workspace-recent-option"
                    aria-current={path === cwd ? "true" : undefined}
                    aria-label={`${pathName(path)}, ${path}`}
                    title={path}
                    disabled={disabled}
                    className={chipOption}
                    onClick={() => {
                      choose(path);
                      setFolderOpen(false);
                    }}
                  >
                    <Folder size={14} aria-hidden="true" className="shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{pathName(path)}</span>
                      <span
                        dir="rtl"
                        className="block truncate text-left text-xs text-muted-foreground"
                      >
                        <bdi dir="ltr">{path}</bdi>
                      </span>
                    </span>
                    {path === cwd && <Check size={14} aria-hidden="true" />}
                  </button>
                ))}
                {!history.recent.length && (
                  <p className="px-2 py-2 text-sm text-muted-foreground">No recent folders</p>
                )}
              </div>
            </div>
            <button
              type="button"
              data-chip-option
              data-testid="chat-workspace-browse"
              disabled={disabled}
              className={chipOption}
              onClick={() => {
                setFolderOpen(false);
                void pick();
              }}
            >
              <FolderOpen size={14} aria-hidden="true" />
              <span className="flex-1">Browse folders…</span>
            </button>
            <form
              className="flex min-w-0 gap-1 border-t border-border px-1 pt-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                event.stopPropagation();
                applyDraft();
              }}
            >
              <Input
                data-testid="chat-workspace-cwd"
                aria-label="Folder path"
                placeholder="Folder path"
                maxLength={4096}
                value={pathDraft ?? cwd}
                disabled={disabled}
                onChange={(event) => setPathDraft(event.target.value)}
                className="min-w-0 font-mono text-xs"
              />
              <button
                type="submit"
                data-testid="chat-workspace-apply"
                disabled={disabled}
                className="inline-flex min-h-8 shrink-0 items-center rounded-md px-2 text-sm hover:bg-surface-highest focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-40 max-sm:min-h-11 pointer-coarse:min-h-11"
              >
                Apply
              </button>
            </form>
          </div>
        </PopoverContent>
      </Popover>
      {showBranch && (
        <Popover open={branchOpen} onOpenChange={setBranchOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-testid="chat-workspace-branch"
              data-worktree={worktree ? "true" : "false"}
              aria-label={`Branch: ${branchChipLabel({ branch, worktree })}`}
              title={branchChipLabel({ branch, worktree })}
              disabled={disabled}
              className={cn(composerChip, "max-w-56")}
            >
              {worktree ? (
                <GitBranchPlus size={14} aria-hidden="true" className="shrink-0" />
              ) : (
                <GitBranch size={14} aria-hidden="true" className="shrink-0" />
              )}
              <span data-chip-label className="min-w-0 truncate">
                {branchChipLabel({ branch, worktree })}
              </span>
              <ChevronDown
                data-chip-label
                size={12}
                aria-hidden="true"
                className="shrink-0 opacity-60"
              />
            </button>
          </PopoverTrigger>
          <PopoverContent
            data-testid="chat-workspace-branch-picker"
            aria-label="Branch"
            side="top"
            align="start"
            className="w-72 p-1.5"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              focusChipOption(branchList.current);
            }}
          >
            <div
              ref={branchList}
              role="menu"
              aria-label="Where the session runs"
              onKeyDown={onChipListKeyDown}
            >
              <p className={chipHeading}>Run in</p>
              {[false, true].map((next) => (
                <button
                  type="button"
                  key={String(next)}
                  role="menuitemradio"
                  data-chip-option
                  data-testid={next ? "chat-workspace-worktree" : "chat-workspace-checkout"}
                  aria-checked={worktree === next}
                  disabled={disabled || (next && !cwd.trim())}
                  className={chipOption}
                  onClick={() => {
                    setWorkspace({ host, cwd, worktree: next });
                    setBranchOpen(false);
                  }}
                >
                  {next ? (
                    <GitBranchPlus size={14} aria-hidden="true" />
                  ) : (
                    <GitBranch size={14} aria-hidden="true" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">
                      {next
                        ? branchChipLabel({ branch, worktree: true })
                        : `Current checkout${branch ? ` · ${branch}` : ""}`}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {next ? "Isolated checkout for this session" : "Work in the folder as it is"}
                    </span>
                  </span>
                  {worktree === next && <Check size={14} aria-hidden="true" />}
                </button>
              ))}
              {git.isError && (
                <p className="px-2 pt-1 text-xs text-muted-foreground">
                  Git details are unavailable for this folder.
                </p>
              )}
            </div>
          </PopoverContent>
        </Popover>
      )}
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
    </fieldset>
  );
}
