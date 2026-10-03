import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInside, removeWorktree, trackedWorktrees } from "../git/worktrees.js";
import { runGit } from "../terminals/session-dir.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

const folder = mkdtempSync(join(tmpdir(), "orc-git-integration-"));
const repo = join(folder, "repo");
const clean = join(folder, "clean");
const unmerged = join(folder, "unmerged");
const deps = { runGit, platform: process.platform, terminalUsing: () => null };
let app: ReturnType<typeof setupTestApp>;

async function git(...args: string[]): Promise<string> {
  const result = await runGit(["git", "-C", repo, ...args]);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout;
}

beforeAll(async () => {
  mkdirSync(repo);
  await git("init", "-b", "main");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "test");
  writeFileSync(join(repo, "file.txt"), "one\n");
  await git("add", ".");
  await git("commit", "-m", "initial");
  await git("worktree", "add", "-b", "orc/clean", clean);
  await git("worktree", "add", "-b", "orc/wip", unmerged);
  writeFileSync(join(unmerged, "file.txt"), "two\n");
  await runGit(["git", "-C", unmerged, "commit", "-am", "wip"]);
  app = setupTestApp();
});
afterAll(teardownTestApp);

describe("worktree registry and cleanup", () => {
  test("should detect merged against main even when called from the feature checkout", async () => {
    const listing = await trackedWorktrees(unmerged, deps);
    expect(listing.worktrees.find((tree) => tree.branch === "orc/clean")?.merged).toBe(true);
    expect(listing.worktrees.find((tree) => tree.branch === "orc/wip")?.merged).toBe(false);
  });
  test("should retain repo tracking after a terminal closes and deduplicate worktree scopes", async () => {
    await req(app, "POST", "/projects", { name: "git-one", scope: repo });
    await req(app, "POST", "/projects", { name: "git-two", scope: clean });
    const response = await req(app, "GET", "/git/registry");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(
      body.repos.filter(
        (item: { root: string }) => item.root.replaceAll("\\", "/") === repo.replaceAll("\\", "/"),
      ),
    ).toHaveLength(1);
  });
  test("should refuse unsafe branch deletion before removing the folder", async () => {
    await expect(
      removeWorktree({ cwd: repo, path: unmerged, delete_branch: true }, deps),
    ).rejects.toThrow(/not merged/);
    expect(existsSync(unmerged)).toBe(true);
  });
  test("should report partial results and safely delete only merged orc branches", async () => {
    const response = await req(app, "POST", "/git/worktrees/cleanup", {
      items: [
        { cwd: repo, path: unmerged },
        { cwd: repo, path: clean, delete_branch: true },
        { cwd: repo, path: repo },
      ],
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results.map((result: { removed: boolean }) => result.removed)).toEqual([
      false,
      true,
      false,
    ]);
    expect(existsSync(clean)).toBe(false);
    expect(existsSync(unmerged)).toBe(true);
    expect(await git("branch", "--list", "orc/clean")).toBe("");
  });
  test("should detect gone upstream without treating an unmerged branch as safely merged", async () => {
    await git("remote", "add", "origin", join(folder, "remote.git"));
    await git("config", "branch.orc/wip.remote", "origin");
    await git("config", "branch.orc/wip.merge", "refs/heads/orc/wip");
    const listing = await trackedWorktrees(repo, deps);
    expect(listing.worktrees.find((tree) => tree.branch === "orc/wip")).toMatchObject({
      upstream_gone: true,
      stale: true,
      merged: false,
    });
  });
  test("should refuse locked and active worktrees at cleanup time", async () => {
    await git("worktree", "lock", unmerged);
    await expect(removeWorktree({ cwd: repo, path: unmerged }, deps)).rejects.toThrow(/Unlock/);
    await git("worktree", "unlock", unmerged);
    await expect(
      removeWorktree({ cwd: repo, path: unmerged }, { ...deps, terminalUsing: () => "busy" }),
    ).rejects.toThrow(/Close it first/);
    expect(existsSync(unmerged)).toBe(true);
  });
  test("should clean only the selected missing checkout and keep its branch", async () => {
    const missing = join(folder, "missing");
    await git("worktree", "add", "-b", "orc/missing", missing);
    renameSync(missing, join(folder, "moved-fixture"));
    const listing = await trackedWorktrees(repo, deps);
    expect(listing.worktrees.find((tree) => tree.branch === "orc/missing")?.prunable).toBe(true);
    await removeWorktree({ cwd: repo, path: missing }, deps);
    expect(
      (await trackedWorktrees(repo, deps)).worktrees.some((tree) => tree.branch === "orc/missing"),
    ).toBe(false);
    expect(await git("branch", "--list", "orc/missing")).toContain("orc/missing");
  });
  test("should protect filesystem routes with authentication", async () => {
    expect((await app.request("/api/git/registry")).status).toBe(401);
    expect((await req(app, "POST", "/git/worktrees/cleanup", { items: [] })).status).toBe(400);
  });
  test("should recognize a running terminal's checkout through directory aliases", () => {
    const alias = join(folder, "alias");
    symlinkSync(unmerged, alias, process.platform === "win32" ? "junction" : "dir");
    expect(isInside(alias, unmerged, process.platform)).toBe(true);
  });
});
