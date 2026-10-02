import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isInside,
  listWorktrees,
  parseWorktreeList,
  removeWorktree,
  samePath,
  WorktreeDirtyError,
} from "../git/worktrees.js";
import { prepareSessionDirectory, runGit } from "../terminals/session-dir.js";

describe("parseWorktreeList", () => {
  test("reads main, linked, detached and prunable entries", () => {
    const porcelain = [
      "worktree /work/app",
      "HEAD aaa",
      "branch refs/heads/master",
      "",
      "worktree /work/worktrees/app/one",
      "HEAD bbb",
      "branch refs/heads/orc/one",
      "locked",
      "",
      "worktree /work/worktrees/app/two",
      "HEAD ccc",
      "detached",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n");
    const [main, one, two] = parseWorktreeList(porcelain);
    expect(main).toMatchObject({ branch: "master", main: true, head: "aaa" });
    expect(one).toMatchObject({ branch: "orc/one", main: false, locked: true });
    expect(two).toMatchObject({ branch: null, detached: true, prunable: true, main: false });
  });

  test("a bare repo's own entry is left out but still counts as the main one", () => {
    const porcelain =
      "worktree /work/app.git\nbare\n\nworktree /work/wt\nHEAD x\nbranch refs/heads/a\n";
    const entries = parseWorktreeList(porcelain);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.main).toBe(false);
  });
});

describe("path helpers", () => {
  test("windows paths compare without case and slash differences", () => {
    expect(samePath("C:/Projects/App/", "c:\\projects\\app", "win32")).toBe(
      process.platform === "win32",
    );
    expect(samePath("/a/b", "/a/b/", "linux")).toBe(true);
  });

  test("a path is inside its parent but not inside a sibling with the same prefix", () => {
    const base = join(tmpdir(), "wt");
    expect(isInside(join(base, "one", "src"), join(base, "one"), process.platform)).toBe(true);
    expect(isInside(join(base, "one-two"), join(base, "one"), process.platform)).toBe(false);
  });
});

describe("worktrees with git", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "orc-worktrees-")));
  const repo = join(root, "repo");
  const deps = { runGit, platform: process.platform, terminalUsing: () => null };

  async function git(args: string[], cwd: string): Promise<string> {
    const result = await runGit(["git", "-C", cwd, ...args]);
    if (result.code !== 0) throw new Error(result.stderr);
    return result.stdout;
  }

  async function addWorktree(id: string): Promise<string> {
    return prepareSessionDirectory(
      { cwd: repo, worktree: true },
      {
        isDirectory: () => true,
        home: root,
        runGit,
        makeDirectory: (path) => mkdirSync(path, { recursive: true }),
        newId: () => id,
      },
    );
  }

  test("setup", async () => {
    mkdirSync(repo);
    await git(["init", "-b", "main"], repo);
    await git(["config", "user.email", "test@example.com"], repo);
    await git(["config", "user.name", "test"], repo);
    writeFileSync(join(repo, "README.md"), "hi\n");
    await git(["add", "README.md"], repo);
    await git(["commit", "-m", "init"], repo);
  });

  test("a plain folder has no listing", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(await listWorktrees(plain, deps)).toEqual({ root: null, worktrees: [] });
  });

  test("lists the main checkout and linked worktrees with their branch and dirty state", async () => {
    const clean = await addWorktree("clean1");
    const dirty = await addWorktree("dirty1");
    writeFileSync(join(dirty, "new.txt"), "wip\n");

    const listing = await listWorktrees(join(clean), deps);
    expect(listing.root && samePath(listing.root, clean, process.platform)).toBe(true);
    const byBranch = Object.fromEntries(listing.worktrees.map((w) => [w.branch, w]));
    expect(byBranch.main).toMatchObject({ main: true, dirty: false });
    expect(byBranch["orc/clean1"]).toMatchObject({ main: false, dirty: false });
    expect(byBranch["orc/dirty1"]).toMatchObject({ main: false, dirty: true });
    expect(samePath(byBranch["orc/clean1"]?.path ?? "", clean, process.platform)).toBe(true);
  });

  test("the main checkout cannot be removed", async () => {
    await expect(removeWorktree({ cwd: repo, path: repo }, deps)).rejects.toThrow(/main checkout/);
  });

  test("a path that is not one of the repo's worktrees is rejected", async () => {
    await expect(removeWorktree({ cwd: repo, path: root }, deps)).rejects.toThrow(/Not a worktree/);
  });

  test("a worktree with a running terminal is not removed", async () => {
    const path = join(root, "worktrees", "repo", "clean1");
    await expect(
      removeWorktree({ cwd: repo, path }, { ...deps, terminalUsing: () => "repo clean1" }),
    ).rejects.toThrow(/Close it first/);
    expect(existsSync(path)).toBe(true);
  });

  test("a clean worktree is removed and its branch kept", async () => {
    const path = join(root, "worktrees", "repo", "clean1");
    await removeWorktree({ cwd: repo, path }, deps);
    expect(existsSync(path)).toBe(false);
    expect(await git(["branch", "--list", "orc/clean1"], repo)).toContain("orc/clean1");
  });

  test("a dirty worktree needs force", async () => {
    const path = join(root, "worktrees", "repo", "dirty1");
    await expect(removeWorktree({ cwd: repo, path }, deps)).rejects.toBeInstanceOf(
      WorktreeDirtyError,
    );
    expect(existsSync(path)).toBe(true);
    await removeWorktree({ cwd: repo, path, force: true }, deps);
    expect(existsSync(path)).toBe(false);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });
});
