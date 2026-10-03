import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GitResult, prepareSessionDirectory } from "../terminals/session-dir.js";

function deps(over: Partial<Parameters<typeof prepareSessionDirectory>[1]> = {}) {
  return {
    isDirectory: (path: string) => path.startsWith("/work") || path.startsWith("/home"),
    home: "/home/me",
    runGit: async (): Promise<GitResult> => ({ code: 0, stdout: "", stderr: "" }),
    makeDirectory: () => {},
    newId: () => "abc123",
    ...over,
  };
}

describe("prepareSessionDirectory", () => {
  test("without a worktree the session opens in the chosen folder", async () => {
    const cwd = await prepareSessionDirectory({ cwd: "/work/app", worktree: false }, deps());
    expect(cwd).toBe("/work/app");
  });

  test("an empty folder falls back to home", async () => {
    const cwd = await prepareSessionDirectory({ cwd: "  ", worktree: true }, deps());
    expect(cwd).toBe("/home/me");
  });

  test("a missing directory is rejected", async () => {
    await expect(
      prepareSessionDirectory({ cwd: "/etc/missing", worktree: false }, deps()),
    ).rejects.toThrow(/not a directory/);
  });

  test("a folder that is not a git repo opens there anyway", async () => {
    const calls: string[][] = [];
    const cwd = await prepareSessionDirectory(
      { cwd: "/work/notes", worktree: true },
      deps({
        runGit: async (args) => {
          calls.push(args);
          return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
        },
      }),
    );
    expect(cwd).toBe("/work/notes");
    expect(calls.some((args) => args.includes("worktree"))).toBe(false);
  });

  test("a git repo gets a new worktree and branch next to the repo", async () => {
    const calls: string[][] = [];
    const made: string[] = [];
    const cwd = await prepareSessionDirectory(
      { cwd: "/work/app/src", worktree: true },
      deps({
        makeDirectory: (path) => made.push(path),
        runGit: async (args) => {
          calls.push(args);
          if (args.includes("rev-parse")) {
            return { code: 0, stdout: "/work/app\n", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      }),
    );
    expect(cwd).toBe(join("/work", "worktrees", "app", "abc123"));
    expect(made).toContain(join("/work", "worktrees", "app"));
    expect(calls[1]).toEqual([
      "git",
      "-C",
      "/work/app",
      "worktree",
      "add",
      "-b",
      "orc/abc123",
      cwd,
    ]);
  });

  test("a git failure other than 'not a repository' is rejected", async () => {
    await expect(
      prepareSessionDirectory(
        { cwd: "/work/app", worktree: true },
        deps({
          runGit: async (args) => {
            if (args.includes("rev-parse")) {
              return { code: 0, stdout: "/work/app\n", stderr: "" };
            }
            return { code: 128, stdout: "", stderr: "fatal: branch already exists" };
          },
        }),
      ),
    ).rejects.toThrow(/branch already exists/);
  });
});

describe("prepareSessionDirectory with git", () => {
  const roots: string[] = [];

  async function git(args: string[], cwd: string): Promise<void> {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    if (code !== 0) throw new Error(stderr);
  }

  test("creates a worktree for a repo and opens a plain folder as itself", async () => {
    const root = mkdtempSync(join(tmpdir(), "orc-session-dir-"));
    roots.push(root);
    const plain = join(root, "plain");
    const repo = join(root, "repo");
    mkdirSync(plain);
    mkdirSync(repo);
    await git(["init"], repo);
    await git(["config", "user.email", "test@example.com"], repo);
    await git(["config", "user.name", "test"], repo);
    writeFileSync(join(repo, "README.md"), "hi\n");
    await git(["add", "README.md"], repo);
    await git(["commit", "-m", "init"], repo);

    const { runGit } = await import("../terminals/session-dir.js");
    const plainCwd = await prepareSessionDirectory(
      { cwd: plain, worktree: true },
      {
        isDirectory: () => true,
        home: root,
        runGit,
        makeDirectory: (path) => mkdirSync(path, { recursive: true }),
        newId: () => "plain01",
      },
    );
    expect(plainCwd).toBe(plain);

    const worktree = await prepareSessionDirectory(
      { cwd: repo, worktree: true },
      {
        isDirectory: () => true,
        home: root,
        runGit,
        makeDirectory: (path) => mkdirSync(path, { recursive: true }),
        newId: () => "wt0001",
      },
    );
    expect(worktree).toBe(join(root, "worktrees", "repo", "wt0001"));
    const branch = Bun.spawn(["git", "branch", "--show-current"], {
      cwd: worktree,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect((await new Response(branch.stdout).text()).trim()).toBe("orc/wt0001");
  });

  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
});
