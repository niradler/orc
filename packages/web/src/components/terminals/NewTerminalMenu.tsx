import { useQuery } from "@tanstack/react-query";
import { FolderOpen, GitBranch, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  api,
  type CreateTerminalInput,
  type TerminalKind,
  type Worktree,
} from "@/api/client";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { RemoteFolderBrowser } from "@/components/terminals/RemoteFolderBrowser";
import { useRemoveWorktree, useWorktrees } from "@/hooks/useGit";
import { useSsh } from "@/hooks/useSsh";
import { cwdTail, TERMINAL_KINDS } from "@/lib/terminal-kinds";
import {
  CWD_KEY,
  launchRequest,
  needsFolderPick,
  readLaunchPrefs,
  saveLaunchPref,
  WORKTREE_KEY,
} from "@/lib/terminal-launch";
import { cn } from "@/lib/utils";

interface NewTerminalMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  launchers: TerminalKind[];
  host: string | null;
  pending: boolean;
  error: string | null;
  onCreate: (input: CreateTerminalInput) => Promise<boolean>;
  className?: string;
}

type Removal = { worktree: Worktree; step: "confirm" | "dirty" };

const storage = (() => {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
})();

function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function NewTerminalMenu({
  open,
  onOpenChange,
  launchers: defaultLaunchers,
  host: defaultHost,
  pending,
  error,
  onCreate,
  className,
}: NewTerminalMenuProps) {
  const [prefs] = useState(() => readLaunchPrefs(storage));
  const [host, setHost] = useState<string | null>(defaultHost);
  const [cwd, setCwd] = useState(defaultHost ? "" : prefs.cwd);
  const [worktree, setWorktree] = useState(prefs.worktree);
  const [browsing, setBrowsing] = useState(false);
  const [remoteBrowsing, setRemoteBrowsing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [removal, setRemoval] = useState<Removal | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const folders = useRef(
    new Map<string | null, string>([[defaultHost, defaultHost ? "" : prefs.cwd]]),
  );
  const { data: ssh, error: hostsError } = useSsh();
  const remoteSupported = !host || ssh?.supported === true;
  const {
    data: hostInfo,
    error: hostError,
    isFetching: checkingHost,
  } = useQuery({
    queryKey: ["terminal-launchers", host],
    queryFn: () => api.terminals.list(host),
    enabled: open && remoteSupported,
    retry: false,
    staleTime: 30_000,
  });
  let launchers: TerminalKind[] = [];
  if (hostInfo?.ready) launchers = hostInfo.launchers;
  else if (!hostInfo && host === defaultHost && !hostError && remoteSupported) {
    launchers = defaultLaunchers;
  }

  const folder = useDebounced(cwd.trim(), 300);
  const folderHost = useDebounced(host ?? "", 300);
  const { data: listing } = useWorktrees(
    open && remoteSupported && folderHost === (host ?? "") ? folder : "",
    host,
  );
  const removeWorktree = useRemoveWorktree();
  const rows = listing?.root ? listing.worktrees : [];
  const busy = pending || browsing || checkingHost || !remoteSupported;

  useEffect(() => {
    // The confirm dialog is portalled outside the menu; clicks in it must not close the menu.
    if (!open || removal) return;
    rootRef.current?.querySelector<HTMLInputElement>("input[data-testid='terminal-cwd']")?.focus();
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onOpenChange(false);
        rootRef.current
          ?.querySelector<HTMLButtonElement>("button[data-testid='terminal-new']")
          ?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onOpenChange, removal]);

  const chooseFolder = (path: string) => {
    setCwd(path);
    folders.current.set(host, path);
    if (host === null) saveLaunchPref(storage, CWD_KEY, path);
  };

  const chooseHost = (alias: string | null) => {
    folders.current.set(host, cwd);
    setHost(alias);
    setCwd(folders.current.get(alias) ?? "");
    setRemoteBrowsing(false);
    setLocalError(null);
    setRemoval(null);
  };

  const browse = async (): Promise<string | null> => {
    setLocalError(null);
    if (host) {
      setRemoteBrowsing(true);
      return null;
    }
    setBrowsing(true);
    try {
      const { path } = await api.terminals.pickFolder(cwd.trim() || undefined, null);
      if (path) chooseFolder(path);
      return path;
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBrowsing(false);
    }
  };

  const launch = async (kind: TerminalKind) => {
    setLocalError(null);
    let folderToUse = cwd.trim();
    if (needsFolderPick(kind, folderToUse)) {
      const picked = await browse();
      if (!picked) return;
      folderToUse = picked;
    }
    if (await onCreate({ ...launchRequest(kind, folderToUse, worktree), host })) {
      if (host === null) saveLaunchPref(storage, CWD_KEY, folderToUse);
    }
  };

  const openCheckout = (kind: TerminalKind, row: Worktree) => {
    setLocalError(null);
    void onCreate({ ...launchRequest(kind, row.path, false), host });
  };

  const remove = async (target: Removal) => {
    setLocalError(null);
    // Ask git from the main checkout: the folder in the field may be the worktree being removed.
    const main = rows.find((row) => row.main)?.path ?? folder;
    try {
      await removeWorktree.mutateAsync({
        cwd: main,
        path: target.worktree.path,
        force: target.step === "dirty",
        host,
      });
      setRemoval(null);
      if (target.worktree.path === folder) chooseFolder(main);
    } catch (e) {
      if (e instanceof ApiError && e.code === "WORKTREE_DIRTY") {
        setRemoval({ worktree: target.worktree, step: "dirty" });
        return;
      }
      setRemoval(null);
      setLocalError(e instanceof Error ? e.message : String(e));
    }
  };

  const confirmRemove = () => {
    if (!removal) return;
    if (removal.step === "confirm" && removal.worktree.dirty) {
      setRemoval({ worktree: removal.worktree, step: "dirty" });
      return;
    }
    void remove(removal);
  };

  const shownError =
    localError ??
    error ??
    (host && !remoteSupported ? ssh?.unsupported_reason : null) ??
    hostError?.message ??
    hostsError?.message ??
    hostInfo?.reason;

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        data-testid="terminal-new"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="w-full inline-flex items-center justify-center gap-2 min-h-11 px-3 py-2 rounded-md bg-primary border border-primary text-primary-foreground font-label text-xs hover:bg-primary/90 transition-colors"
      >
        <Plus size={14} />
        New terminal
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="New terminal"
          data-testid="terminal-launch-menu"
          className="absolute right-0 md:left-0 md:right-auto top-full mt-1 z-30 w-[22rem] max-w-[calc(100vw-2rem)] bg-surface-high border border-outline-variant rounded-lg shadow-xl p-3 space-y-3 max-h-[70dvh] overflow-y-auto"
        >
          <label className="flex items-center gap-2 font-label text-xs text-on-surface-variant">
            Host
            <select
              data-testid="terminal-host-select"
              value={host ?? ""}
              onChange={(event) => chooseHost(event.target.value || null)}
              disabled={pending || browsing}
              className="min-w-0 flex-1 min-h-11 rounded-md border border-control-border bg-background px-2 text-on-surface focus:outline-none focus:ring-2 focus:ring-focus"
            >
              <option value="">Local</option>
              {[...new Set([...(ssh?.hosts ?? []), ...(ssh?.host ? [ssh.host] : [])])].map(
                (alias) => (
                  <option key={alias} value={alias}>
                    {alias}
                  </option>
                ),
              )}
            </select>
          </label>
          <label className="block">
            <span className="font-label text-xs text-on-surface-variant">
              Working directory
              {host && (
                <span
                  data-testid="terminal-host"
                  className="ml-1 px-1 rounded-md bg-surface-highest text-on-surface normal-case tracking-normal"
                >
                  on {host}
                </span>
              )}
            </span>
            <div className="mt-1 flex gap-1">
              <input
                type="text"
                data-testid="terminal-cwd"
                value={cwd}
                onChange={(e) => chooseFolder(e.target.value)}
                placeholder="~ (home folder)"
                spellCheck={false}
                className="min-w-0 flex-1 bg-background border border-control-border rounded-md min-h-11 px-2 py-1 font-body text-base sm:text-sm text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:ring-2 focus:ring-focus"
              />
              <button
                type="button"
                data-testid="terminal-browse"
                disabled={busy}
                onClick={() => void browse()}
                title="Choose a folder"
                className="shrink-0 inline-flex items-center gap-1 min-h-11 px-2 py-1 rounded-md border border-control-border font-label text-xs text-on-surface-variant hover:bg-surface hover:text-on-surface disabled:opacity-50"
              >
                <FolderOpen size={12} />
                {browsing ? "Choosing" : "Browse"}
              </button>
            </div>
          </label>
          {host && remoteBrowsing && (
            <RemoteFolderBrowser
              key={host}
              host={host}
              initial={cwd.trim()}
              onPick={(path) => {
                chooseFolder(path);
                setRemoteBrowsing(false);
              }}
              onClose={() => setRemoteBrowsing(false)}
            />
          )}
          <label className="flex items-center gap-2 px-1 cursor-pointer select-none">
            <input
              type="checkbox"
              data-testid="terminal-worktree"
              checked={worktree}
              onChange={(e) => {
                setWorktree(e.target.checked);
                saveLaunchPref(storage, WORKTREE_KEY, e.target.checked ? "1" : "0");
              }}
              className="accent-primary"
            />
            <span className="font-body text-xs text-on-surface-variant">
              New git worktree for agents
            </span>
          </label>
          <div className="space-y-0.5">
            {launchers.map((kind) => {
              const { label, icon: Icon } = TERMINAL_KINDS[kind];
              return (
                <button
                  key={kind}
                  type="button"
                  data-testid={`terminal-launch-${kind}`}
                  disabled={busy}
                  onClick={() => void launch(kind)}
                  className="w-full flex items-center gap-2 min-h-11 px-2 py-1.5 rounded-md font-label text-xs text-on-surface-variant hover:bg-surface hover:text-on-surface disabled:opacity-50"
                >
                  <Icon size={14} />
                  {label}
                </button>
              );
            })}
            {launchers.length === 0 && (
              <p className="min-h-11 px-2 py-1 font-body text-base sm:text-sm text-on-surface-variant">
                No launchers available
              </p>
            )}
          </div>
          {rows.length > 0 && (
            <div data-testid="terminal-worktrees" className="border-t border-surface-highest pt-2">
              <p className="px-1 pb-1 font-label text-xs text-on-surface-variant">Checkouts</p>
              <ul className="max-h-56 overflow-y-auto space-y-0.5">
                {rows.map((row) => (
                  <li
                    key={row.path}
                    data-testid="terminal-worktree-row"
                    className="group flex items-center gap-2 px-1 py-1 rounded-md hover:bg-surface"
                  >
                    <div className="min-w-0 flex-1" title={row.path}>
                      <div className="flex items-center gap-1 font-body text-xs text-on-surface">
                        <GitBranch size={11} className="shrink-0 text-on-surface-variant" />
                        <span className="truncate">
                          {row.branch ?? (row.head ? row.head.slice(0, 8) : "detached")}
                        </span>
                        {row.main && (
                          <span className="shrink-0 px-1 rounded-md bg-surface-highest text-on-surface font-label text-xs">
                            main
                          </span>
                        )}
                        {row.dirty && (
                          <span className="shrink-0 px-1 rounded-md text-tertiary font-label text-xs">
                            dirty
                          </span>
                        )}
                        {row.prunable && (
                          <span className="shrink-0 px-1 rounded-md text-error font-label text-xs">
                            missing
                          </span>
                        )}
                      </div>
                      <div className="truncate font-body text-xs text-on-surface-variant">
                        {cwdTail(row.path)}
                      </div>
                    </div>
                    {!row.prunable &&
                      launchers.map((kind) => {
                        const { label, icon: Icon } = TERMINAL_KINDS[kind];
                        return (
                          <button
                            key={kind}
                            type="button"
                            data-testid={`terminal-worktree-open-${kind}`}
                            disabled={busy}
                            onClick={() => openCheckout(kind, row)}
                            title={`Open ${label} here`}
                            aria-label={`Open ${label} in ${row.path}`}
                            className="shrink-0 min-h-11 min-w-11 sm:min-h-8 sm:min-w-8 inline-flex items-center justify-center p-1 rounded-md text-on-surface-variant hover:bg-surface hover:text-on-surface disabled:opacity-50"
                          >
                            <Icon size={12} />
                          </button>
                        );
                      })}
                    {!row.main && (
                      <button
                        type="button"
                        data-testid="terminal-worktree-remove"
                        disabled={busy || removeWorktree.isPending}
                        onClick={() => setRemoval({ worktree: row, step: "confirm" })}
                        title="Remove worktree"
                        aria-label={`Remove worktree ${row.path}`}
                        className="shrink-0 min-h-11 min-w-11 sm:min-h-8 sm:min-w-8 inline-flex items-center justify-center p-1 rounded-md text-on-surface-variant hover:bg-error/15 hover:text-error disabled:opacity-50"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {shownError && (
            <p role="alert" className="px-1 font-body text-xs text-error break-words">
              {shownError}
            </p>
          )}
        </div>
      )}
      <ConfirmDialog
        open={removal !== null}
        onCancel={() => setRemoval(null)}
        onConfirm={confirmRemove}
        isPending={removeWorktree.isPending}
        title={removal?.step === "dirty" ? "Discard uncommitted changes?" : "Remove worktree?"}
        description={
          removal?.step === "dirty"
            ? `${removal.worktree.path} has uncommitted changes. Removing it deletes them for good.`
            : `Deletes the folder ${removal?.worktree.path ?? ""}. The branch ${removal?.worktree.branch ?? ""} is kept.`
        }
        confirmLabel={removal?.step === "dirty" ? "Discard and remove" : "Remove"}
      />
    </div>
  );
}
