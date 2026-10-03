import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { API_SECRET, apiGet, apiPost, tid } from "./_helpers";

const folder = mkdtempSync(join(tmpdir(), "orc-pw-git-"));
const repo = join(folder, "repo");
const checkout = join(folder, "checkout");
async function git(cwd: string, ...args: string[]): Promise<void> {
  execFileSync("git", ["-C", cwd, ...args], { timeout: 15_000, windowsHide: true });
}
test.beforeAll(async () => {
  mkdirSync(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "test");
  writeFileSync(join(repo, "file.txt"), "initial\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initial");
  await git(repo, "worktree", "add", "-b", "orc/e2e-clean", checkout);
});

test("slice 1 terminal menu, real shell and slice 2 worktree cleanup", async ({
  page,
  request,
}) => {
  await apiPost(request, "/projects", { name: tid("git-e2e"), scope: repo });
  await page.addInitScript((secret) => localStorage.setItem("orc_api_secret", secret), API_SECRET);
  await page.goto("/terminals");
  await page.getByTestId("terminal-new").click();
  await page.getByTestId("terminal-cwd").fill(repo);
  await expect(page.getByTestId("terminal-worktree-row")).toHaveCount(2);
  await expect(page.getByTestId("terminal-browse")).toBeVisible();
  await page.getByTestId("terminal-worktree").check();
  await page.getByTestId("terminal-launch-shell").click();
  await expect(page.getByTestId("terminal-viewport")).toBeVisible();
  await page.getByTestId("worktree-registry-toggle").click();
  const row = page.getByTestId("registry-worktree").filter({ hasText: "orc/e2e-clean" });
  await expect(row).toContainText("merged");
  await row.getByTestId("registry-worktree-select").check();
  await page.getByTestId("cleanup-delete-branch").check();
  await page.getByTestId("worktree-cleanup").click();
  await page.getByTestId("confirm-dialog-confirm").click();
  await expect(page.getByTestId("cleanup-result")).toContainText("removed");
  await expect(row).toHaveCount(0);
});

test("slice 3 git panel status, diff, selected staging, commit, branches and task links", async ({
  page,
  request,
}) => {
  const task = await apiPost<{ id: string }>(request, "/tasks", { title: tid("git-panel-task") });
  const terminal = await apiPost<{ id: string }>(request, "/terminals", {
    kind: "shell",
    cwd: repo,
  });
  writeFileSync(join(repo, "file.txt"), "panel edit\n");
  writeFileSync(join(repo, "untracked.txt"), "keep unstaged\n");
  await page.addInitScript((secret) => localStorage.setItem("orc_api_secret", secret), API_SECRET);
  await page.goto(`/terminals/${terminal.id}`);
  await page.getByTestId("terminal-git-toggle").click();
  await expect(page.getByTestId("git-status-file")).toHaveCount(2);
  await page.getByTestId("git-tab-diff").click();
  await expect(page.getByTestId("git-diff")).toContainText("+panel edit");
  await page.getByTestId("git-tab-status").click();
  await page
    .getByTestId("git-status-file")
    .filter({ hasText: "file.txt" })
    .locator("input")
    .check();
  await page.getByTestId("git-stage").click();
  await expect(page.getByTestId("git-status-file").filter({ hasText: "file.txt" })).toContainText(
    "M",
  );
  await page.getByTestId("git-commit-message").fill("Commit via terminal panel");
  await page.getByTestId("git-commit").click();
  await expect(page.getByTestId("git-status-file")).toHaveCount(1);
  await page.getByTestId("git-tab-branches").click();
  await expect(page.getByTestId("git-panel-worktree").first()).toContainText("main");
  await page.getByTestId("git-link-task").selectOption(task.id);
  await page.getByTestId("git-link-save").click();
  await page.getByTestId("git-linked-task").click();
  await expect(page.getByTestId("task-git-links")).toContainText("main");
  await page.reload();
  await expect(page.getByTestId("task-git-links")).toContainText(repo);
});

test("slice 4 GitHub board filtering, linking, creating task and reopening saved links", async ({
  page,
  request,
}) => {
  const task = await apiPost<{ id: string }>(request, "/tasks", { title: tid("github-task") });
  const issue = {
    repo: "niradler/orc",
    number: 123,
    title: "Relevant issue",
    url: "https://github.com/niradler/orc/issues/123",
    kind: "issue",
    state: "open",
    branch: null,
    assignees: ["niradler"],
    task_ids: [] as string[],
  };
  const pull = {
    ...issue,
    number: 51,
    title: "Terminal worktrees",
    url: "https://github.com/niradler/orc/pull/51",
    kind: "pr",
    branch: "feat/terminal-worktrees",
    assignees: [],
  };
  await page.route("**/api/github/items?*", async (route) => {
    const filter = new URL(route.request().url()).searchParams.get("filter");
    const tasks = await apiGet<{
      tasks: { id: string; github_issue: string | null; github_pr: string | null }[];
    }>(request, "/tasks?limit=100");
    const items = (
      filter === "assigned" ? [issue] : filter === "branches" ? [pull] : [issue, pull]
    ).map((item) => ({
      ...item,
      task_ids: tasks.tasks
        .filter((task) => task.github_issue === item.url || task.github_pr === item.url)
        .map((task) => task.id),
    }));
    await route.fulfill({
      json: { auth: "gh", login: "niradler", items, errors: [], truncated: false },
    });
  });
  await page.addInitScript((secret) => localStorage.setItem("orc_api_secret", secret), API_SECRET);
  await page.goto("/tasks");
  await page.getByTestId("github-board-toggle").click();
  await expect(page.getByTestId("github-item")).toHaveCount(2);
  await page.getByTestId("github-filter").selectOption("assigned");
  await expect(page.getByTestId("github-item")).toHaveCount(1);
  await page.getByTestId("github-link-task").selectOption(task.id);
  await page.getByTestId("github-link-save").click();
  await expect(page.getByTestId("github-linked-task")).toBeVisible();
  await page.getByTestId("github-filter").selectOption("branches");
  await expect(page.getByTestId("github-item")).toContainText("Terminal worktrees");
  await page.getByTestId("github-create-task").click();
  await expect(page.getByTestId("github-linked-task")).toBeVisible();
  await page.getByTestId("github-linked-task").click();
  await expect(page.getByTestId("task-git-links")).toContainText(
    "https://github.com/niradler/orc/pull/51",
  );
  await page.reload();
  await expect(page.getByTestId("task-git-links")).toContainText("feat/terminal-worktrees");
});
