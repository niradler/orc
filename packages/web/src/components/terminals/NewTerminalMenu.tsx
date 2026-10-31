import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { FolderOpen, GitBranch, Plus, Trash2, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import {
  ApiError,
  api,
  type CreateTerminalInput,
  type TerminalKind,
  type Worktree,
} from "@/api/client";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { FolderPickerDialog } from "@/components/FolderPickerDialog";
import { RecentFolders } from "@/components/RecentFolders";
import { useFolderPickerSession } from "@/hooks/useFolderPickerSession";
import { useRemoveWorktree, useWorktrees } from "@/hooks/useGit";
import { useSsh } from "@/hooks/useSsh";
import { folderHistory, rememberFolder } from "@/lib/folder-history";
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
import { TerminalSelect } from "./TerminalSelect";

interface NewTerminalMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  launchers: TerminalKind[];
  host: string | null;
  pending: boolean;
  error: string | null;
  onCreate: (input: CreateTerminalInput) => Promise<boolean>;
  className?: string;
  compact?: boolean;
  iconOnly?: boolean;
  draft?: ReturnType<typeof useTerminalLaunchDraft>;
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

export function useTerminalLaunchDraft(defaultHost: string | null, open: boolean) {
  const [prefs] = useState(() => readLaunchPrefs(storage));
  const [host, setHost] = useState<string | null>(defaultHost);
  const [cwd, setCwd] = useState(
    () => folderHistory(defaultHost).last || (defaultHost ? "" : prefs.cwd),
  );
  const [worktree, setWorktree] = useState(prefs.worktree);
  const [remoteBrowsing, setRemoteBrowsing] = useState(false);
  const folders = useRef(
    new Map<string | null, string>([
      [null, folderHistory(null).last || prefs.cwd],
      [defaultHost, folderHistory(defaultHost).last || (defaultHost ? "" : prefs.cwd)],
    ]),
  );
  const previouslyOpen = useRef(false);
  useEffect(() => {
    const opening = open && !previouslyOpen.current;
    previouslyOpen.current = open;
    if (!open) setRemoteBrowsing(false);
    if (opening) {
      const last = folderHistory(host).last;
      if (last) setCwd(last);
    }
  }, [open, host]);
  const folderPickerSession = useFolderPickerSession();
  const previousDefault = useRef(defaultHost);
  useEffect(() => {
    if (previousDefault.current === defaultHost) return;
    previousDefault.current = defaultHost;
    setHost(defaultHost);
    setCwd(folders.current.get(defaultHost) ?? folderHistory(defaultHost).last);
    setRemoteBrowsing(false);
  }, [defaultHost]);
  return {
    host,
    setHost,
    cwd,
    setCwd,
    worktree,
    setWorktree,
    remoteBrowsing,
    setRemoteBrowsing,
    folders,
    folderPickerSession,
  };
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
  compact = false,
  iconOnly = false,
  draft,
}: NewTerminalMenuProps) {
  const hostSelectId = useId();
  const localDraft = useTerminalLaunchDraft(defaultHost, open);
  const {
    host,
    setHost,
    cwd,
    setCwd,
    worktree,
    setWorktree,
    remoteBrowsing,
    setRemoteBrowsing,
    folders,
    folderPickerSession,
  } = draft ?? localDraft;
  const [localError, setLocalError] = useState<string | null>(null);
  const [removal, setRemoval] = useState<Removal | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const folderTrigger = useRef<HTMLButtonElement>(null);
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
  const busy = pending || checkingHost || !remoteSupported;

  useEffect(() => {
    // Portalled child dialogs own outside clicks and Escape until they close.
    if (!open || removal || remoteBrowsing) return;
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
  }, [open, onOpenChange, removal, remoteBrowsing]);

  const chooseFolder = (path: string) => {
    setCwd(path);
    folders.current.set(host, path);
    if (host === null) saveLaunchPref(storage, CWD_KEY, path);
  };

  const chooseHost = (alias: string | null) => {
    folders.current.set(host, cwd);
    setHost(alias);
    setCwd(folders.current.get(alias) ?? folderHistory(alias).last);
    setRemoteBrowsing(false);
    setLocalError(null);
    setRemoval(null);
  };

  const browse = () => {
    folderPickerSession.reset(cwd.trim());
    setLocalError(null);
    setRemoteBrowsing(true);
  };

  const launch = async (kind: TerminalKind) => {
    setLocalError(null);
    const folderToUse = cwd.trim();
    if (needsFolderPick(kind, folderToUse)) {
      browse();
      return;
    }
    if (await onCreate({ ...launchRequest(kind, folderToUse, worktree), host })) {
      rememberFolder(host, folderToUse);
      if (host === null) saveLaunchPref(storage, CWD_KEY, folderToUse);
    }
  };

  const openCheckout = (kind: TerminalKind, row: Worktree) => {
    setLocalError(null);
    rememberFolder(host, row.path);
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
  const MenuSurface = compact ? DialogPrimitive.Content : "div";

  return (
    <DialogPrimitive.Root
      open={compact && open}
      onOpenChange={(next) => {
        if (!remoteBrowsing) onOpenChange(next);
      }}
    >
      <div ref={rootRef} className={cn("relative", className)}>
        <button
          type="button"
          data-testid="terminal-new"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
          title="New terminal"
          className={cn(
            "min-w-11 inline-flex items-center justify-center gap-2 min-h-11 rounded-md font-label text-xs transition-colors",
            iconOnly
              ? "w-11 shrink-0 sm:w-8 sm:min-w-8 sm:min-h-8 text-on-surface-variant hover:bg-surface"
              : "w-full px-3 py-2 bg-primary border border-primary text-primary-foreground hover:bg-primary/90",
          )}
        >
          <Plus size={14} />
          <span className={compact || iconOnly ? "sr-only" : undefined}>New terminal</span>
        </button>
        {compact && open && <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70" />}
        {open && (
          <MenuSurface
            {...(compact
              ? {
                  onCloseAutoFocus: (event: Event) => {
                    event.preventDefault();
                    rootRef.current
                      ?.querySelector<HTMLButtonElement>('[data-testid="terminal-new"]')
                      ?.focus();
                  },
                }
              : {})}
            role="dialog"
            aria-label="New terminal"
            aria-describedby={undefined}
            data-testid="terminal-launch-menu"
            className={cn(
              "terminal-launch-controls bg-surface-high border border-outline-variant rounded-lg shadow-xl p-3 space-y-3 overflow-y-auto overscroll-contain",
              compact
                ? "fixed inset-x-3 top-[calc(var(--app-top,0px)+env(safe-area-inset-top)+1rem)] z-50 max-h-[calc(var(--app-height,100dvh)-2rem)]"
                : "absolute left-0 top-full mt-1 z-30 w-88 max-w-[calc(100vw-2rem)] max-h-[70dvh]",
            )}
          >
            {compact && (
              <div className="flex items-center justify-between">
                <DialogPrimitive.Title className="text-sm font-medium">
                  New terminal
                </DialogPrimitive.Title>
                <DialogPrimitive.Close
                  className="flex size-11 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface"
                  aria-label="Close terminal launcher"
                >
                  <X size={18} />
                </DialogPrimitive.Close>
              </div>
            )}
            <label
              htmlFor={hostSelectId}
              className="flex items-center gap-2 text-sm text-on-surface-variant"
            >
              Host
              <TerminalSelect
                id={hostSelectId}
                data-testid="terminal-host-select"
                value={host ?? ""}
                onChange={(event) => chooseHost(event.target.value || null)}
                disabled={pending}
              >
                <option value="">Local</option>
                {[...new Set([...(ssh?.hosts ?? []), ...(ssh?.host ? [ssh.host] : [])])].map(
                  (alias) => (
                    <option key={alias} value={alias}>
                      {alias}
                    </option>
                  ),
                )}
              </TerminalSelect>
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
                  onBlur={() => rememberFolder(host, cwd)}
                  placeholder="~ (home folder)"
                  spellCheck={false}
                  className="min-w-0 flex-1 bg-background border border-control-border rounded-md min-h-11 px-2 py-1 font-body text-base sm:text-sm text-on-surface placeholder:text-on-surface-variant focus:outline-hidden focus:ring-2 focus:ring-focus"
                />
                <button
                  type="button"
                  data-testid="terminal-browse"
                  ref={folderTrigger}
                  disabled={busy}
                  onClick={browse}
                  title="Choose a folder"
                  className="shrink-0 inline-flex items-center gap-1 min-h-11 px-2 py-1 rounded-md border border-control-border font-label text-xs text-on-surface-variant hover:bg-surface hover:text-on-surface disabled:opacity-50"
                >
                  <FolderOpen size={12} />
                  Browse
                </button>
              </div>
            </label>
            <RecentFolders
              host={host}
              disabled={pending}
              onPick={(path) => {
                chooseFolder(path);
                rememberFolder(host, path);
              }}
            />
            <FolderPickerDialog
              session={folderPickerSession}
              open={remoteBrowsing}
              onOpenChange={setRemoteBrowsing}
              host={host}
              initial={cwd.trim()}
              returnFocusRef={folderTrigger}
              onPick={(path) => {
                chooseFolder(path);
                rememberFolder(host, path);
              }}
            />
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
              <span className="font-body text-xs text-on-surface-variant">New git worktree</span>
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
              <div
                data-testid="terminal-worktrees"
                className="border-t border-surface-highest pt-2"
              >
                <p className="px-1 pb-1 font-label text-xs text-on-surface-variant">Checkouts</p>
                <ul className="max-h-56 overflow-y-auto space-y-0.5">
                  {rows.map((row) => (
                    <li
                      key={row.path}
                      data-testid="terminal-worktree-row"
                      className="group flex flex-wrap sm:flex-nowrap items-center gap-x-2 px-1 py-1 rounded-md hover:bg-surface"
                    >
                      {/* On narrow screens the actions wrap below so the branch stays readable. */}
                      <div className="min-w-0 basis-full sm:basis-auto sm:flex-1" title={row.path}>
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
                      <div className="ml-auto flex shrink-0 items-center">
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
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {shownError && (
              <p role="alert" className="px-1 font-body text-xs text-error wrap-break-word">
                {shownError}
              </p>
            )}
          </MenuSurface>
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
    </DialogPrimitive.Root>
  );
}
