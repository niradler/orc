import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, GitBranch, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  ApiError,
  api,
  type BranchPull,
  type CreateTerminalInput,
  type TerminalKind,
  type Worktree,
} from "@/api/client";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useRemoveWorktree } from "@/hooks/useGit";
import { cwdTail, TERMINAL_KINDS } from "@/lib/terminal-kinds";
import { launchRequest } from "@/lib/terminal-launch";
import { cn } from "@/lib/utils";

type Filter = "all" | "cleanable" | "pr";
type Removal = { cwd: string; worktree: Worktree; step: "confirm" | "dirty" };

// Squash and rebase merges leave the branch outside the default branch's history, so a merged
// PR only counts while the branch still points at the commit GitHub merged. The server rechecks.
export function prMerged(tree: Worktree, pull: BranchPull | undefined): boolean {
  return pull?.state === "merged" && Boolean(tree.head) && pull.head_sha === tree.head;
}

export function cleanable(tree: Worktree, pull: BranchPull | undefined): boolean {
  return (
    !tree.main &&
    !tree.dirty &&
    !tree.locked &&
    !tree.active_terminal &&
    Boolean(tree.merged || tree.prunable || prMerged(tree, pull))
  );
}

const PR_TONE: Record<BranchPull["state"], string> = {
  open: "text-success",
  merged: "text-primary",
  closed: "text-on-surface-variant",
};

function Badge({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-md bg-surface-highest px-1.5 font-label text-xs leading-5",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function WorktreeManager({
  launchers,
  host,
  onCreate,
  className,
}: {
  launchers: TerminalKind[];
  // The registry inspects repositories on the API's execution host, so terminals open there too.
  host: string | null;
  onCreate: (input: CreateTerminalInput) => Promise<boolean>;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<Record<string, { cwd: string; path: string }>>({});
  const [confirm, setConfirm] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [removal, setRemoval] = useState<Removal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const client = useQueryClient();
  const registry = useQuery({
    queryKey: ["worktrees", "registry"],
    queryFn: () => api.git.registry(),
    enabled: open,
  });
  const pulls = useQuery({
    queryKey: ["worktrees", "registry", "pulls"],
    queryFn: () => api.git.registryPulls(),
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });
  const removeWorktree = useRemoveWorktree();
  const pullOf = (root: string | null, branch: string | null): BranchPull | undefined =>
    branch ? pulls.data?.repos.find((repo) => repo.root === root)?.pulls[branch] : undefined;
  const trees = (registry.data?.repos ?? []).flatMap((repo) =>
    repo.worktrees.map((tree) => ({ root: repo.root ?? "", tree })),
  );
  const cleanup = useMutation({
    mutationFn: () =>
      api.git.cleanup(
        Object.values(selected).map((item) => {
          const entry = trees.find(({ tree }) => tree.path === item.path);
          const merged =
            entry &&
            (entry.tree.merged || prMerged(entry.tree, pullOf(entry.root, entry.tree.branch)));
          return {
            ...item,
            delete_branch:
              deleteBranch && Boolean(merged && entry?.tree.branch?.startsWith("orc/")),
          };
        }),
      ),
    onSuccess: () => {
      setSelected({});
      setConfirm(false);
      void client.invalidateQueries({ queryKey: ["worktrees"] });
    },
  });
  const candidates = trees.filter(({ root, tree }) => cleanable(tree, pullOf(root, tree.branch)));
  const count = Object.keys(selected).length;

  const remove = async (target: Removal) => {
    setError(null);
    try {
      await removeWorktree.mutateAsync({
        cwd: target.cwd,
        path: target.worktree.path,
        force: target.step === "dirty",
      });
      setRemoval(null);
      setSelected(({ [target.worktree.path]: _, ...rest }) => rest);
    } catch (e) {
      if (e instanceof ApiError && e.code === "WORKTREE_DIRTY") {
        setRemoval({ ...target, step: "dirty" });
        return;
      }
      setRemoval(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const openHere = async (kind: TerminalKind, tree: Worktree) => {
    setError(null);
    if (await onCreate({ ...launchRequest(kind, tree.path, false), host })) setOpen(false);
  };

  const toggle = (cwd: string, path: string, on: boolean) =>
    setSelected((old) => {
      const next = { ...old };
      if (on) next[path] = { cwd, path };
      else delete next[path];
      return next;
    });

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        data-testid="worktree-manager-open"
        onClick={() => setOpen(true)}
        className={cn("min-h-11 sm:min-h-8 gap-1.5", className)}
      >
        <GitBranch size={14} />
        Worktrees
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          data-testid="worktree-manager"
          className="max-w-3xl gap-3 bg-surface p-4 sm:p-6 border-surface-highest"
        >
          <DialogHeader className="pr-8 text-left">
            <DialogTitle className="font-headline text-base text-on-surface">Worktrees</DialogTitle>
            <DialogDescription className="font-body text-xs text-on-surface-variant">
              Checkouts of every repository ORC knows about: project folders, sessions and recent
              terminals. Merged, squash-merged and missing worktrees can be cleaned up.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            <div role="radiogroup" aria-label="Show" className="flex gap-1">
              {(
                [
                  ["all", "All"],
                  ["cleanable", `Cleanable (${candidates.length})`],
                  ["pr", "With PR"],
                ] as const
              ).map(([value, label]) => (
                // biome-ignore lint/a11y/useSemanticElements: styled segmented control
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={filter === value}
                  data-testid={`worktree-filter-${value}`}
                  onClick={() => setFilter(value)}
                  className={cn(
                    "min-h-11 sm:min-h-8 rounded-md px-2 font-label text-xs",
                    filter === value
                      ? "bg-surface-highest text-on-surface"
                      : "text-on-surface-variant hover:bg-surface-high",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <Button
              variant="ghost"
              size="sm"
              data-testid="worktree-registry-refresh"
              onClick={() => {
                void registry.refetch();
                void pulls.refetch();
              }}
              disabled={registry.isFetching}
              className="ml-auto min-h-11 sm:min-h-8 gap-1.5"
            >
              <RefreshCw size={14} className={cn(registry.isFetching && "animate-spin")} />
              Refresh
            </Button>
          </div>
          {pulls.data?.auth === "none" && (
            <p className="font-body text-xs text-on-surface-variant">
              Sign in with gh or set a GitHub token to match pull requests to branches.
            </p>
          )}
          {[
            ...(pulls.data?.errors ?? []),
            ...(pulls.error ? [{ repo: "GitHub", error: pulls.error.message }] : []),
          ].map((item) => (
            <p key={item.repo} className="font-body text-xs text-tertiary">
              {item.repo}: {item.error}
            </p>
          ))}
          <div className="min-h-0 space-y-4">
            {registry.isLoading && (
              <p className="font-body text-sm text-on-surface-variant">Loading repositories…</p>
            )}
            {registry.error && (
              <p role="alert" className="font-body text-sm text-error">
                {registry.error.message}
              </p>
            )}
            {registry.data?.repos.length === 0 && (
              <p className="font-body text-sm text-on-surface-variant">
                No known repositories. Set a project folder or launch a terminal in a repository.
              </p>
            )}
            {registry.data?.repos.map((repo) => {
              const root = repo.root ?? "";
              const github = pulls.data?.repos.find((item) => item.root === repo.root)?.repo;
              const shown = repo.worktrees.filter((tree) => {
                const pull = pullOf(repo.root, tree.branch);
                if (filter === "cleanable") return cleanable(tree, pull);
                if (filter === "pr") return Boolean(pull);
                return true;
              });
              if (!shown.length) return null;
              return (
                <section key={root} data-testid="worktree-repo" className="space-y-1">
                  <header className="flex flex-wrap items-baseline gap-x-2">
                    <h3 className="font-label text-sm text-on-surface">{cwdTail(root)}</h3>
                    {github && (
                      <span className="font-body text-xs text-on-surface-variant">{github}</span>
                    )}
                    <span className="basis-full break-all font-body text-xs text-outline">
                      {root}
                    </span>
                  </header>
                  <ul className="divide-y divide-surface-highest rounded-md border border-surface-highest">
                    {shown.map((tree) => {
                      const pull = pullOf(repo.root, tree.branch);
                      const eligible = cleanable(tree, pull);
                      return (
                        <li
                          key={tree.path}
                          data-testid="registry-worktree"
                          className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5 sm:flex-nowrap"
                        >
                          <input
                            type="checkbox"
                            data-testid="registry-worktree-select"
                            aria-label={`Select ${tree.branch ?? tree.path} for cleanup`}
                            title={
                              eligible
                                ? "Select for cleanup"
                                : "Only clean, inactive merged or missing worktrees can be cleaned"
                            }
                            disabled={!eligible || cleanup.isPending}
                            checked={Boolean(selected[tree.path])}
                            onChange={(event) => toggle(root, tree.path, event.target.checked)}
                            className="size-4 shrink-0 accent-primary"
                          />
                          {/* Phones: checkbox and branch fill the first line, the actions wrap below. */}
                          <div
                            data-testid="registry-worktree-label"
                            className="min-w-0 flex-1 basis-[calc(100%-1.5rem)] sm:basis-0"
                            title={tree.path}
                          >
                            <div className="flex flex-wrap items-center gap-1 font-body text-sm text-on-surface">
                              <span className="min-w-0 break-all">
                                {tree.branch ?? (tree.head ? tree.head.slice(0, 8) : "detached")}
                              </span>
                              {tree.main && <Badge>main</Badge>}
                              {pull && (
                                <a
                                  href={pull.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  data-testid="worktree-pr"
                                  title={pull.title}
                                  className={cn(
                                    "inline-flex shrink-0 items-center gap-0.5 rounded-md bg-surface-highest px-1.5 font-label text-xs leading-5 hover:underline",
                                    PR_TONE[pull.state],
                                  )}
                                >
                                  #{pull.number}{" "}
                                  {pull.draft && pull.state === "open" ? "draft" : pull.state}
                                  <ExternalLink size={10} />
                                </a>
                              )}
                              {tree.merged && !tree.main && (
                                <Badge className="text-primary">merged</Badge>
                              )}
                              {!tree.merged && prMerged(tree, pull) && (
                                <Badge className="text-primary">squash-merged</Badge>
                              )}
                              {tree.upstream_gone && <Badge>upstream gone</Badge>}
                              {tree.prunable && <Badge className="text-error">missing</Badge>}
                              {tree.dirty && <Badge className="text-tertiary">dirty</Badge>}
                              {tree.locked && <Badge>locked</Badge>}
                              {tree.active_terminal && (
                                <Badge className="text-success">
                                  running: {tree.active_terminal}
                                </Badge>
                              )}
                            </div>
                            <div className="truncate font-body text-xs text-on-surface-variant">
                              {tree.path}
                            </div>
                          </div>
                          <div className="ml-auto flex shrink-0 items-center">
                            {!tree.prunable &&
                              launchers.map((kind) => {
                                const { label, icon: Icon } = TERMINAL_KINDS[kind];
                                return (
                                  <button
                                    key={kind}
                                    type="button"
                                    data-testid={`worktree-open-${kind}`}
                                    onClick={() => void openHere(kind, tree)}
                                    title={`Open ${label} here`}
                                    aria-label={`Open ${label} in ${tree.path}`}
                                    className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface-high hover:text-on-surface sm:min-h-8 sm:min-w-8"
                                  >
                                    <Icon size={14} />
                                  </button>
                                );
                              })}
                            {!tree.main && (
                              <button
                                type="button"
                                data-testid="worktree-remove"
                                disabled={removeWorktree.isPending || Boolean(tree.active_terminal)}
                                onClick={() =>
                                  setRemoval({ cwd: root, worktree: tree, step: "confirm" })
                                }
                                title={
                                  tree.active_terminal
                                    ? "Close its terminal first"
                                    : "Remove worktree"
                                }
                                aria-label={`Remove worktree ${tree.path}`}
                                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-on-surface-variant hover:bg-error/15 hover:text-error disabled:opacity-40 sm:min-h-8 sm:min-w-8"
                              >
                                <Trash2 size={14} />
                              </button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
            {registry.data?.errors.map((item) => (
              <p
                key={item.cwd}
                role="alert"
                className="font-body text-xs text-error wrap-break-word"
              >
                {item.cwd}: {item.error}
              </p>
            ))}
          </div>
          {error && (
            <p role="alert" className="font-body text-xs text-error wrap-break-word">
              {error}
            </p>
          )}
          {cleanup.error && (
            <p role="alert" className="font-body text-xs text-error wrap-break-word">
              {cleanup.error.message}
            </p>
          )}
          {cleanup.data?.results.map((result) => (
            <p
              key={result.path}
              data-testid="cleanup-result"
              role={result.error ? "alert" : undefined}
              className={cn(
                "font-body text-xs break-all",
                result.error ? "text-error" : "text-on-surface-variant",
              )}
            >
              {result.path}: {result.removed ? "removed" : result.error}
            </p>
          ))}
          <div className="flex flex-wrap items-center gap-2 border-t border-surface-highest pt-3">
            <Button
              variant="ghost"
              size="sm"
              data-testid="worktree-select-cleanable"
              disabled={!candidates.length || cleanup.isPending}
              onClick={() =>
                setSelected(
                  Object.fromEntries(
                    candidates.map(({ root, tree }) => [tree.path, { cwd: root, path: tree.path }]),
                  ),
                )
              }
              className="min-h-11 sm:min-h-8"
            >
              Select cleanable
            </Button>
            <label className="flex min-h-11 items-center gap-2 font-body text-xs text-on-surface-variant sm:min-h-8">
              <input
                type="checkbox"
                data-testid="cleanup-delete-branch"
                checked={deleteBranch}
                onChange={(event) => setDeleteBranch(event.target.checked)}
                className="accent-primary"
              />
              Also delete merged orc/* branches
            </label>
            <Button
              size="sm"
              data-testid="worktree-cleanup"
              disabled={!count || cleanup.isPending}
              onClick={() => setConfirm(true)}
              className="ml-auto min-h-11 sm:min-h-8"
            >
              Clean selected ({count})
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirm}
        title="Clean selected worktrees?"
        description={`Remove ${count} selected worktree folders. Dirty, locked, active and unmerged worktrees are refused. ${deleteBranch ? "Merged orc/* branches will also be deleted." : "Branches are kept."}`}
        confirmLabel="Clean selected"
        isPending={cleanup.isPending}
        onConfirm={() => cleanup.mutate()}
        onCancel={() => setConfirm(false)}
      />
      <ConfirmDialog
        open={removal !== null}
        isPending={removeWorktree.isPending}
        title={removal?.step === "dirty" ? "Discard uncommitted changes?" : "Remove worktree?"}
        description={
          removal?.step === "dirty"
            ? `${removal.worktree.path} has uncommitted changes. Removing it deletes them for good.`
            : `Deletes the folder ${removal?.worktree.path ?? ""}. The branch ${removal?.worktree.branch ?? ""} is kept.`
        }
        confirmLabel={removal?.step === "dirty" ? "Discard and remove" : "Remove"}
        onConfirm={() => {
          if (!removal) return;
          if (removal.step === "confirm" && removal.worktree.dirty)
            setRemoval({ ...removal, step: "dirty" });
          else void remove(removal);
        }}
        onCancel={() => setRemoval(null)}
      />
    </>
  );
}
