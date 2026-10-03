import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitStatus, parseStatus } from "../git/panel.js";
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
});
