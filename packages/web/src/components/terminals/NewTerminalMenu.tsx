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
import { useRemoveWorktree, useWorktrees } from "@/hooks/useGit";
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
  pending: boolean;
  error: string | null;
  onCreate: (input: CreateTerminalInput) => Promise<boolean>;
  className?: string;
}

type Removal = { worktree: Worktree; step: "confirm" | "dirty" };

const storage = typeof window === "undefined" ? undefined : window.localStorage;

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
  launchers,
  pending,
  error,
  onCreate,
  className,
}: NewTerminalMenuProps) {
  const [prefs] = useState(() => readLaunchPrefs(storage));
  const [cwd, setCwd] = useState(prefs.cwd);
  const [worktree, setWorktree] = useState(prefs.worktree);
  const [browsing, setBrowsing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [removal, setRemoval] = useState<Removal | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const folder = useDebounced(cwd.trim(), 300);
  const { data: listing } = useWorktrees(open ? folder : "");
  const removeWorktree = useRemoveWorktree();
  const rows = listing?.root ? listing.worktrees : [];
  const busy = pending || browsing;

  useEffect(() => {
    // The confirm dialog is portalled outside the menu; clicks in it must not close the menu.
    if (!open || removal) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onOpenChange, removal]);

  const chooseFolder = (path: string) => {
    setCwd(path);
    saveLaunchPref(storage, CWD_KEY, path);
  };

  const browse = async (): Promise<string | null> => {
    setBrowsing(true);
    setLocalError(null);
    try {
      const { path } = await api.terminals.pickFolder(cwd.trim() || undefined);
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
    if (await onCreate(launchRequest(kind, folderToUse, worktree))) {
      saveLaunchPref(storage, CWD_KEY, folderToUse);
    }
  };

  const openCheckout = (kind: TerminalKind, row: Worktree) => {
    setLocalError(null);
    void onCreate(launchRequest(kind, row.path, false));
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

  const shownError = localError ?? error;

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        data-testid="terminal-new"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-sm bg-primary/15 border border-primary/30 text-primary font-label text-xs uppercase tracking-widest hover:bg-primary/25 transition-colors"
      >
        <Plus size={14} />
        New terminal
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full mt-1 z-30 w-[22rem] max-w-[calc(100vw-2rem)] bg-surface border border-surface-highest rounded-sm shadow-xl p-2 space-y-2"
        >
          <label className="block">
            <span className="font-label text-[10px] uppercase tracking-widest text-outline">
              Working directory
            </span>
            <div className="mt-1 flex gap-1">
              <input
                type="text"
                data-testid="terminal-cwd"
                value={cwd}
                onChange={(e) => chooseFolder(e.target.value)}
                placeholder="~ (home folder)"
                spellCheck={false}
                className="min-w-0 flex-1 bg-surface-low border border-surface-highest rounded-sm px-2 py-1 font-body text-xs text-on-surface placeholder:text-outline focus:outline-none focus:ring-1 focus:ring-primary/40"
              />
              <button
                type="button"
                data-testid="terminal-browse"
                disabled={busy}
                onClick={() => void browse()}
                title="Choose a folder"
                className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-sm border border-surface-highest font-label text-[10px] uppercase tracking-widest text-on-surface-variant hover:bg-surface-highest hover:text-on-surface disabled:opacity-50"
              >
                <FolderOpen size={12} />
                {browsing ? "Choosing" : "Browse"}
              </button>
            </div>
          </label>
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
                  role="menuitem"
                  data-testid={`terminal-launch-${kind}`}
                  disabled={busy}
                  onClick={() => void launch(kind)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-sm font-label text-xs uppercase tracking-widest text-on-surface-variant hover:bg-surface-highest hover:text-on-surface disabled:opacity-50"
                >
                  <Icon size={14} />
                  {label}
                </button>
              );
            })}
            {launchers.length === 0 && (
              <p className="px-2 py-1 font-body text-xs text-outline">No launchers available</p>
            )}
          </div>
          {rows.length > 0 && (
            <div data-testid="terminal-worktrees" className="border-t border-surface-highest pt-2">
              <p className="px-1 pb-1 font-label text-[10px] uppercase tracking-widest text-outline">
                Checkouts
              </p>
              <ul className="max-h-56 overflow-y-auto space-y-0.5">
                {rows.map((row) => (
                  <li
                    key={row.path}
                    data-testid="terminal-worktree-row"
                    className="group flex items-center gap-2 px-1 py-1 rounded-sm hover:bg-surface-low"
                  >
                    <div className="min-w-0 flex-1" title={row.path}>
                      <div className="flex items-center gap-1 font-body text-xs text-on-surface">
                        <GitBranch size={11} className="shrink-0 text-outline" />
                        <span className="truncate">
                          {row.branch ?? (row.head ? row.head.slice(0, 8) : "detached")}
                        </span>
                        {row.main && (
                          <span className="shrink-0 px-1 rounded-sm bg-primary/15 text-primary font-label text-[9px] uppercase tracking-widest">
                            main
                          </span>
                        )}
                        {row.dirty && (
                          <span className="shrink-0 px-1 rounded-sm bg-tertiary/15 text-tertiary font-label text-[9px] uppercase tracking-widest">
                            dirty
                          </span>
                        )}
                        {row.prunable && (
                          <span className="shrink-0 px-1 rounded-sm bg-error/15 text-error font-label text-[9px] uppercase tracking-widest">
                            missing
                          </span>
                        )}
                      </div>
                      <div className="truncate font-body text-[10px] text-outline">
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
                            className="shrink-0 p-1 rounded-sm text-outline hover:bg-surface-highest hover:text-on-surface disabled:opacity-50"
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
                        className="shrink-0 p-1 rounded-sm text-outline hover:bg-error/15 hover:text-error disabled:opacity-50"
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
