import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitStatus, parseStatus } from "../git/panel.js";
import { listWorktrees } from "../git/worktrees.js";
import { shutdownTerminals } from "../terminals/service.js";
import { runGit } from "../terminals/session-dir.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof setupTestApp>;
let terminalId: string;
const repo = mkdtempSync(join(tmpdir(), "orc-panel-"));
beforeAll(async () => {
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "test"],
  ]) {
    const result = await runGit(["git", "-C", repo, ...args]);
    if (result.code) throw new Error(result.stderr);
  }
  writeFileSync(join(repo, "file.txt"), "before\n");
  await runGit(["git", "-C", repo, "add", "."]);
  await runGit(["git", "-C", repo, "commit", "-m", "init"]);
  app = setupTestApp();
  const response = await req(app, "POST", "/terminals", { kind: "shell", cwd: repo });
  expect(response.status).toBe(201);
  terminalId = (await response.json()).id;
});
afterAll(() => {
  shutdownTerminals();
  teardownTestApp();
});

describe("terminal git panel", () => {
  test("should read status and worktrees without refreshing the index", async () => {
    const checkout = mkdtempSync(join(tmpdir(), "orc-index-read-"));
    for (const args of [
      ["init", "-b", "main"],
      ["config", "user.email", "test@example.com"],
      ["config", "user.name", "test"],
    ]) {
      expect((await runGit(["git", "-C", checkout, ...args])).code).toBe(0);
    }
    const file = join(checkout, "tracked.txt");
    writeFileSync(file, "unchanged\n");
    expect((await runGit(["git", "-C", checkout, "add", "."])).code).toBe(0);
    expect((await runGit(["git", "-C", checkout, "commit", "-m", "initial"])).code).toBe(0);
    const index = join(checkout, ".git", "index");
    const before = readFileSync(index);
    utimesSync(file, new Date(0), new Date(0));
    expect((await gitStatus(checkout)).files).toEqual([]);
    expect(readFileSync(index)).toEqual(before);
    expect(
      (await listWorktrees(checkout, { runGit, platform: process.platform })).worktrees[0]?.dirty,
    ).toBe(false);
    expect(readFileSync(index)).toEqual(before);
  });
  test("should save text, preserve shorter writes and refuse stale or unsafe file edits", async () => {
    const route = `/terminals/${terminalId}/files`;
    writeFileSync(join(repo, "editor.txt"), "long original text\r\n");
    const body = { path: "editor.txt", original: "long original text\r\n", content: "short\r\n" };
    expect((await req(app, "PUT", route, body)).status).toBe(204);
    expect((await (await req(app, "GET", `${route}?path=editor.txt`)).json()).content).toBe(
      "short\r\n",
    );
    expect((await req(app, "PUT", route, body)).status).toBe(409);
    expect((await req(app, "PUT", route, { ...body, path: "../outside" })).status).toBe(400);
    expect((await req(app, "PUT", route, { ...body, path: ".git/config" })).status).toBe(400);
    expect((await req(app, "PUT", route, { ...body, path: "new-file.txt" })).status).toBe(400);
    expect((await req(app, "PUT", route, { ...body, content: "é".repeat(110_000) })).status).toBe(
      400,
    );
    expect(
      (
        await app.request(`/api${route}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(401);
    writeFileSync(join(repo, "editor-binary.bin"), Buffer.from([0, 1, 2]));
    expect(
      (await req(app, "PUT", route, { ...body, path: "editor-binary.bin", original: "\0\x01\x02" }))
        .status,
    ).toBe(400);
    writeFileSync(join(repo, "editor-encoding.bin"), Buffer.from([255, 254, 65]));
    expect(
      (await req(app, "PUT", route, { ...body, path: "editor-encoding.bin", original: "��A" }))
        .status,
    ).toBe(400);
    expect((await (await req(app, "GET", `${route}?path=editor-encoding.bin`)).json()).binary).toBe(
      true,
    );
    writeFileSync(join(repo, "editor-large.txt"), "€".repeat(70_000));
    const large = await (await req(app, "GET", `${route}?path=editor-large.txt`)).json();
    expect(large.truncated).toBe(true);
    expect(large.binary).toBe(false);
    expect((await req(app, "PUT", route, { ...body, path: "editor-large.txt" })).status).toBe(400);
    await runGit([
      "git",
      "-C",
      repo,
      "add",
      "editor.txt",
      "editor-binary.bin",
      "editor-encoding.bin",
      "editor-large.txt",
    ]);
    await runGit(["git", "-C", repo, "commit", "-m", "editor fixtures"]);
  });
  test("browses checkout files and bounds previews without exposing git internals or parent paths", async () => {
    const route = `/terminals/${terminalId}/files`;
    const listed = await req(app, "GET", route);
    expect(listed.status).toBe(200);
    const entries = (await listed.json()).entries;
    expect(entries.some((entry: { name: string }) => entry.name === "file.txt")).toBe(true);
    expect(entries.some((entry: { name: string }) => entry.name === ".git")).toBe(false);
    expect((await (await req(app, "GET", `${route}?path=file.txt`)).json()).content).toBe(
      "before\n",
    );
    expect((await req(app, "GET", `${route}?path=../outside`)).status).toBe(400);
    expect((await req(app, "GET", `${route}?path=.git/config`)).status).toBe(400);
    expect((await req(app, "GET", `${route}?path=missing`)).status).toBe(400);
    writeFileSync(join(repo, "preview.txt"), "x".repeat(210_000));
    const preview = await (await req(app, "GET", `${route}?path=preview.txt`)).json();
    expect(preview.content.length).toBe(200_000);
    expect(preview.truncated).toBe(true);
    await runGit(["git", "-C", repo, "add", "preview.txt"]);
    await runGit(["git", "-C", repo, "commit", "-m", "preview fixture"]);
  });
  test("switches clean local branches and refuses dirty or unknown branches", async () => {
    await runGit(["git", "-C", repo, "branch", "feature"]);
    const route = `/terminals/${terminalId}/git/switch`;
    expect((await req(app, "POST", route, { branch: "feature" })).status).toBe(204);
    expect((await gitStatus(repo)).branch).toBe("feature");
    writeFileSync(join(repo, "file.txt"), "pending change\n");
    expect((await req(app, "POST", route, { branch: "main" })).status).toBe(400);
    expect((await gitStatus(repo)).branch).toBe("feature");
    expect((await req(app, "POST", route, { branch: "--detach" })).status).toBe(400);
    writeFileSync(join(repo, "file.txt"), "before\n");
    expect((await req(app, "POST", route, { branch: "main" })).status).toBe(204);
    const feed = await req(app, "GET", `/terminals/${terminalId}/git/github`);
    expect(feed.status).toBe(200);
    expect((await feed.json()).items).toEqual([]);
  });
  test("should parse spaces, renames and newline filenames without splitting them", () => {
    expect(parseStatus("R  new name\0old name\0?? line\nbreak\0")).toEqual([
      { path: "new name", original: "old name", index: "R", working: " " },
      { path: "line\nbreak", original: null, index: "?", working: "?" },
    ]);
  });
  test("should read status and diff, stage selected files and commit", async () => {
    writeFileSync(join(repo, "file.txt"), "after\n");
    writeFileSync(join(repo, "keep.txt"), "unstaged\n");
    const status = await req(app, "GET", `/terminals/${terminalId}/git/status`);
    expect(status.status).toBe(200);
    expect((await status.json()).branch).toBe("main");
    const diff = await req(app, "GET", `/terminals/${terminalId}/git/diff`);
    expect((await diff.json()).diff).toContain("+after");
    const untracked = await req(app, "GET", `/terminals/${terminalId}/git/diff?path=keep.txt`);
    expect(untracked.status).toBe(200);
    expect((await untracked.json()).diff).toContain("+unstaged");
    const perFile = await req(app, "GET", `/terminals/${terminalId}/git/diff?path=file.txt`);
    const body = (await perFile.json()).diff;
    expect(body).toContain("-before");
    expect(body).not.toContain("unstaged");
    expect(
      (await req(app, "GET", `/terminals/${terminalId}/git/diff?path=../outside`)).status,
    ).toBe(400);
    expect(
      (await req(app, "POST", `/terminals/${terminalId}/git/stage`, { paths: ["../outside"] }))
        .status,
    ).toBe(400);
    expect(
      (await req(app, "POST", `/terminals/${terminalId}/git/stage`, { paths: ["file.txt"] }))
        .status,
    ).toBe(204);
    const staged = await req(app, "GET", `/terminals/${terminalId}/git/diff?staged=1`);
    expect((await staged.json()).diff).toContain("+after");
    expect(
      (await req(app, "POST", `/terminals/${terminalId}/git/commit`, { message: "panel commit" }))
        .status,
    ).toBe(204);
    expect((await gitStatus(repo)).files.map((file) => file.path)).toEqual(["keep.txt"]);
  });
  test("should persist and clear task checkout and GitHub links through detail and list APIs", async () => {
    const created = await req(app, "POST", "/tasks", {
      title: "linked",
      git_repo: repo,
      git_branch: "main",
      git_worktree: repo,
      github_issue: "https://github.com/niradler/orc/issues/12",
    });
    expect(created.status).toBe(201);
    const task = await created.json();
    expect(task.git_branch).toBe("main");
    expect((await (await req(app, "GET", `/tasks/${task.id}`)).json()).git_repo).toBe(repo);
    expect(
      (await (await req(app, "GET", "/tasks")).json()).tasks.find(
        (row: { id: string }) => row.id === task.id,
      ).github_issue,
    ).toContain("/issues/12");
    expect(
      (await req(app, "PATCH", `/tasks/${task.id}`, { github_pr: "javascript:alert(1)" })).status,
    ).toBe(400);
    const updated = await req(app, "PATCH", `/tasks/${task.id}`, {
      git_branch: null,
      github_issue: null,
    });
    expect((await updated.json()).git_branch).toBeNull();
  });
  test("should use checkout root paths when a terminal starts in a subfolder", async () => {
    mkdirSync(join(repo, "sub"));
    writeFileSync(join(repo, "literal[1].txt"), "selected\n");
    writeFileSync(join(repo, "literal1.txt"), "leave alone\n");
    const created = await req(app, "POST", "/terminals", { kind: "shell", cwd: join(repo, "sub") });
    const id = (await created.json()).id;
    expect(
      (await req(app, "POST", `/terminals/${id}/git/stage`, { paths: ["literal[1].txt"] })).status,
    ).toBe(204);
    const status = await gitStatus(repo);
    expect(status.files.find((file) => file.path === "literal[1].txt")?.index).toBe("A");
    expect(status.files.find((file) => file.path === "literal1.txt")?.index).toBe("?");
    const diff = await req(
      app,
      "GET",
      `/terminals/${id}/git/diff?staged=1&path=literal%5B1%5D.txt`,
    );
    expect((await diff.json()).diff).toContain("+selected");
  });
  test("file preview refuses directory aliases outside the checkout or into git metadata", async () => {
    const outside = mkdtempSync(join(tmpdir(), "orc-outside-files-"));
    writeFileSync(join(outside, "private.txt"), "outside content");
    symlinkSync(
      outside,
      join(repo, "outside-alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    symlinkSync(
      join(repo, ".git"),
      join(repo, "git-alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const route = `/terminals/${terminalId}/files`;
    expect((await req(app, "GET", `${route}?path=outside-alias/private.txt`)).status).toBe(400);
    expect((await req(app, "GET", `${route}?path=git-alias/config`)).status).toBe(400);
    expect(
      (
        await req(app, "PUT", route, {
          path: "outside-alias/private.txt",
          original: "outside content",
          content: "changed",
        })
      ).status,
    ).toBe(400);
    expect(
      (await req(app, "PUT", route, { path: "git-alias/config", original: "", content: "changed" }))
        .status,
    ).toBe(400);
    writeFileSync(join(repo, "binary.bin"), Buffer.from([0, 1, 2]));
    const binary = await (await req(app, "GET", `${route}?path=binary.bin`)).json();
    expect(binary.binary).toBe(true);
    expect(binary.content).toBeNull();
  });
});
