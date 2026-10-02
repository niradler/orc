import { normalize, resolve, sep } from "node:path";
import { ConflictError, OrcError, ValidationError } from "@orc/core/errors";
import { type GitResult, gitError, repoRoot } from "../terminals/session-dir.js";

export interface Worktree {
  path: string;
  branch: string | null;
  head: string | null;
  main: boolean;
  dirty: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface WorktreeListing {
  root: string | null;
  worktrees: Worktree[];
}

export interface WorktreeDeps {
  runGit: (argv: string[]) => Promise<GitResult>;
  platform: NodeJS.Platform;
}

export interface RemoveWorktreeRequest {
  cwd: string;
  path: string;
  force?: boolean | undefined;
}

export interface RemoveWorktreeDeps extends WorktreeDeps {
  // Name of a running terminal whose cwd is inside the given path, if any.
  terminalUsing: (path: string) => string | null;
}

export class WorktreeDirtyError extends OrcError {
  constructor(path: string) {
    super(`Worktree has uncommitted changes: ${path}`, "WORKTREE_DIRTY", 409);
    this.name = "WorktreeDirtyError";
  }
}

function comparable(path: string, platform: NodeJS.Platform): string {
  const full = resolve(path).replace(/[\\/]+$/, "");
  return platform === "win32" ? full.toLowerCase() : full;
}

export function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return comparable(a, platform) === comparable(b, platform);
}

export function isInside(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const c = comparable(child, platform);
  const p = comparable(parent, platform);
  return c === p || c.startsWith(p + sep);
}

type Parsed = Omit<Worktree, "dirty">;

export function parseWorktreeList(porcelain: string): Parsed[] {
  const entries: Parsed[] = [];
  let index = 0;
  for (const block of porcelain.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(Boolean);
    const first = lines[0];
    if (!first?.startsWith("worktree ")) continue;
    const main = index++ === 0;
    const entry: Parsed = {
      path: normalize(first.slice("worktree ".length)),
      branch: null,
      head: null,
      main,
      detached: false,
      locked: false,
      prunable: false,
    };
    let bare = false;
    for (const line of lines.slice(1)) {
      if (line.startsWith("HEAD ")) entry.head = line.slice(5);
      else if (line.startsWith("branch "))
        entry.branch = line.slice(7).replace(/^refs\/heads\//, "");
      else if (line === "detached") entry.detached = true;
      else if (line === "bare") bare = true;
      else if (line === "locked" || line.startsWith("locked ")) entry.locked = true;
      else if (line === "prunable" || line.startsWith("prunable ")) entry.prunable = true;
    }
    // A bare repo has no checkout to open or remove.
    if (!bare) entries.push(entry);
  }
  return entries;
}

async function isDirty(path: string, run: WorktreeDeps["runGit"]): Promise<boolean> {
  const result = await run(["git", "-C", path, "status", "--porcelain"]);
  if (result.code !== 0) throw gitError(result, `git status failed in ${path}`);
  return result.stdout.trim().length > 0;
}

export async function listWorktrees(cwd: string, deps: WorktreeDeps): Promise<WorktreeListing> {
  const root = await repoRoot(cwd, deps.runGit);
  if (!root) return { root: null, worktrees: [] };
  const result = await deps.runGit(["git", "-C", root, "worktree", "list", "--porcelain"]);
  if (result.code !== 0) throw gitError(result, "git worktree list failed");
  const parsed = parseWorktreeList(result.stdout);
  const worktrees = await Promise.all(
    parsed.map(async (w) => ({
      ...w,
      dirty: w.prunable ? false : await isDirty(w.path, deps.runGit),
    })),
  );
  return { root: normalize(root), worktrees };
}

export async function removeWorktree(
  req: RemoveWorktreeRequest,
  deps: RemoveWorktreeDeps,
): Promise<void> {
  const listing = await listWorktrees(req.cwd, deps);
  if (!listing.root) throw new ValidationError(`Not a git repository: ${req.cwd}`);
  const target = listing.worktrees.find((w) => samePath(w.path, req.path, deps.platform));
  if (!target) throw new ValidationError(`Not a worktree of ${listing.root}: ${req.path}`);
  if (target.main) throw new ValidationError("The main checkout cannot be removed");

  const user = deps.terminalUsing(target.path);
  if (user)
    throw new ConflictError(`Terminal "${user}" is running in this worktree. Close it first.`);
  if (target.dirty && !req.force) throw new WorktreeDirtyError(target.path);

  const main = listing.worktrees.find((w) => w.main)?.path ?? listing.root;
  const argv = target.prunable
    ? ["git", "-C", main, "worktree", "prune"]
    : ["git", "-C", main, "worktree", "remove", ...(req.force ? ["--force"] : []), target.path];
  const result = await deps.runGit(argv);
  if (result.code !== 0) throw gitError(result, "git worktree remove failed");
}
