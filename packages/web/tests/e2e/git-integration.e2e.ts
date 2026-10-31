import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect } from "@playwright/test";
import {
  API_SECRET,
  apiGet,
  apiPost,
  openTerminalOptions,
  splitTerminalPane,
  tid,
} from "./_helpers";
import { test } from "./_terminal-fixture";

const folder = mkdtempSync(join(tmpdir(), "orc-pw-git-"));
const repo = join(folder, "repo");
const checkout = join(folder, "checkout");
const squash = join(folder, "squash");
const openPr = join(folder, "open-pr");
async function git(cwd: string, ...args: string[]): Promise<void> {
  execFileSync("git", ["-C", cwd, ...args], {
    timeout: 15_000,
    windowsHide: true,
  });
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
  await git(repo, "worktree", "add", "-b", "orc/e2e-squash", squash);
  writeFileSync(join(squash, "squash.txt"), "squashed\n");
  await git(squash, "add", ".");
  await git(squash, "commit", "-m", "squash feature");
  await git(repo, "worktree", "add", "-b", "orc/e2e-open", openPr);
  writeFileSync(join(openPr, "open.txt"), "in review\n");
  await git(openPr, "add", ".");
  await git(openPr, "commit", "-m", "open feature");
});

test("slice 1 terminal menu, real shell and slice 2 worktree cleanup", async ({
  page,
  request,
}, testInfo) => {
  await apiPost(request, "/projects", { name: tid("git-e2e"), scope: repo });
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
  const squashHead = execFileSync("git", ["-C", squash, "rev-parse", "HEAD"], {
    timeout: 15_000,
    windowsHide: true,
  })
    .toString()
    .trim();
  // GitHub is not reachable in tests: the matched PRs come from a fixture.
  await page.route("**/api/git/registry/pulls*", (route) =>
    route.fulfill({
      json: {
        auth: "gh",
        errors: [],
        repos: [
          {
            root: repo,
            repo: "owner/repo",
            pulls: {
              "orc/e2e-squash": {
                number: 42,
                title: "Squashed feature",
                url: "https://github.com/owner/repo/pull/42",
                state: "merged",
                draft: false,
                head_sha: squashHead,
              },
              "orc/e2e-open": {
                number: 43,
                title: "Open feature",
                url: "https://github.com/owner/repo/pull/43",
                state: "open",
                draft: false,
                head_sha: null,
              },
            },
          },
        ],
      },
    }),
  );
  await page.goto("/terminals");
  await page.getByTestId("terminal-new").click();
  await page.getByTestId("terminal-cwd").fill(repo);
  await expect(page.getByTestId("terminal-worktree-row")).toHaveCount(4);
  await expect(page.getByText("New git worktree", { exact: true })).toBeVisible();
  await expect(page.getByTestId("terminal-browse")).toBeVisible();
  await page.getByTestId("terminal-worktree").check();
  await page.getByTestId("terminal-launch-shell").click();
  await expect(page.getByTestId("terminal-viewport")).toBeVisible();

  await page.getByTestId("worktree-manager-open").click();
  const manager = page.getByTestId("worktree-manager");
  const row = manager.getByTestId("registry-worktree").filter({ hasText: "orc/e2e-clean" });
  const squashed = manager.getByTestId("registry-worktree").filter({ hasText: "orc/e2e-squash" });
  const open = manager.getByTestId("registry-worktree").filter({ hasText: "orc/e2e-open" });
  await expect(row).toContainText("merged");
  await expect(squashed.getByTestId("worktree-pr")).toHaveText(/#42 merged/);
  await expect(squashed.getByTestId("worktree-pr")).toHaveAttribute(
    "href",
    "https://github.com/owner/repo/pull/42",
  );
  await expect(squashed).toContainText("squash-merged");
  await expect(squashed.getByTestId("registry-worktree-select")).toBeEnabled();
  await expect(open.getByTestId("worktree-pr")).toHaveText(/#43 open/);
  await expect(open.getByTestId("registry-worktree-select")).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("worktree-manager.png") });
  // The registry is shared with other specs, so count only this repo's rows.
  const ours = manager
    .getByTestId("worktree-repo")
    .filter({ hasText: basename(folder) })
    .getByTestId("registry-worktree");
  await manager.getByTestId("worktree-filter-pr").click();
  await expect(ours).toHaveCount(2);
  await manager.getByTestId("worktree-filter-cleanable").click();
  await expect(ours).toHaveCount(2);
  await manager.getByTestId("worktree-filter-all").click();

  await row.getByTestId("registry-worktree-select").check();
  await manager.getByTestId("cleanup-delete-branch").check();
  await manager.getByTestId("worktree-cleanup").click();
  await page.getByTestId("confirm-dialog-confirm").click();
  await expect(manager.getByTestId("cleanup-result")).toContainText("removed");
  await expect(row).toHaveCount(0);

  // A single worktree is removed from its row; the server keeps refusing unverified squash merges.
  await open.getByTestId("worktree-remove").click();
  await page.getByTestId("confirm-dialog-confirm").click();
  await expect(open).toHaveCount(0);
  await squashed.getByTestId("registry-worktree-select").check();
  await manager.getByTestId("worktree-cleanup").click();
  await page.getByTestId("confirm-dialog-confirm").click();
  await expect(manager.getByTestId("cleanup-result")).toContainText(/can be bulk cleaned/);
  await expect(squashed).toHaveCount(1);
});

test("checkouts and the worktree manager stay readable on a phone", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
  await page.goto("/terminals");
  await page.getByTestId("terminal-new").click();
  await page.getByTestId("terminal-cwd").fill(repo);
  const rows = page.getByTestId("terminal-worktree-row");
  await expect(rows.first()).toBeVisible();
  for (const row of await rows.all()) {
    const text = await row.locator("[title]").first().boundingBox();
    const box = await row.boundingBox();
    // The branch and path use the full row width; the actions wrap underneath.
    expect(text?.width ?? 0).toBeGreaterThan((box?.width ?? 0) * 0.8);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("checkouts-phone.png") });

  await page.keyboard.press("Escape");
  await openTerminalOptions(page);
  await page.getByTestId("worktree-manager-open").click();
  const manager = page.getByTestId("worktree-manager");
  await expect(manager.getByTestId("registry-worktree").first()).toBeVisible();
  for (const row of await manager.getByTestId("registry-worktree").all()) {
    const label = await row.getByTestId("registry-worktree-label").boundingBox();
    const rowBox = await row.boundingBox();
    expect(label?.width ?? 0).toBeGreaterThan((rowBox?.width ?? 0) * 0.8);
  }
  const box = await manager.boundingBox();
  expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= 390).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("worktree-manager-phone.png") });
});

test("slice 3 git panel status, diff, selected staging, commit, branches and task links", async ({
  page,
  request,
}) => {
  const task = await apiPost<{ id: string }>(request, "/tasks", {
    title: tid("git-panel-task"),
  });
  const terminal = await apiPost<{ id: string }>(request, "/terminals", {
    kind: "shell",
    cwd: repo,
  });
  writeFileSync(join(repo, "file.txt"), "panel edit\n");
  writeFileSync(join(repo, "untracked.txt"), "keep unstaged\n");
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
  await page.goto(`/terminals/${terminal.id}`);
  await splitTerminalPane(page.getByTestId("workspace-pane").first(), "horizontal");
  await expect(page.getByTestId("terminal-git-toggle")).toHaveCount(0);
  await expect(page.getByTestId("git-status-file")).toHaveCount(2);
  await expect(page.getByTestId("git-branch-select")).toHaveValue("main");
  await page.getByTestId("git-checkout-toggle").click();
  await expect(page.getByTestId("git-tab-status")).toHaveCount(0);
  await expect(page.getByTestId("git-tab-diff")).toHaveCount(0);
  await expect(page.getByTestId("git-tab-branches")).toHaveCount(0);
  const tracked = page.getByTestId("git-diff-file").filter({ hasText: "file.txt" });
  const untracked = page.getByTestId("git-diff-file").filter({ hasText: "untracked.txt" });
  await expect(page.getByTestId("git-diff-file")).toHaveCount(2);
  await expect(tracked.getByTestId("git-diff")).toContainText("+panel edit");
  const colors = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      added: `rgb(${style.getPropertyValue("--success").trim().split(/\s+/).join(", ")})`,
      removed: `rgb(${style.getPropertyValue("--error").trim().split(/\s+/).join(", ")})`,
    };
  });
  await expect(tracked.getByTestId("git-diff-add")).toHaveCSS("color", colors.added);
  await expect(tracked.getByTestId("git-diff-remove")).toHaveCSS("color", colors.removed);
  await untracked.scrollIntoViewIfNeeded();
  await expect(untracked.getByTestId("git-diff")).toContainText("+keep unstaged");
  await expect(untracked.getByTestId("git-diff")).not.toContainText("panel edit");
  await tracked.getByTestId("git-diff-file-toggle").click();
  await expect(tracked.getByTestId("git-diff-file-toggle")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(tracked.getByTestId("git-diff")).toHaveCount(0);
  await expect(untracked.getByTestId("git-diff")).toBeVisible();
  await page.getByTestId("git-diff-collapse-all").click();
  await expect(page.getByTestId("git-diff")).toHaveCount(0);
  await page.getByTestId("git-diff-expand-all").click();
  await expect(page.getByTestId("git-diff")).toHaveCount(2);
  await page.getByTestId("git-select-all").check();
  await expect(page.getByTestId("git-status-file").locator("input:checked")).toHaveCount(2);
  await page.getByTestId("git-select-all").uncheck();
  await page
    .getByTestId("git-status-file")
    .filter({ hasText: "file.txt" })
    .locator("input")
    .check();
  await page.getByTestId("git-stage").click();
  await expect(page.getByTestId("git-status-file").filter({ hasText: "file.txt" })).toContainText(
    "M",
  );
  await expect(tracked.getByTestId("git-file-status")).toContainText("Staged");
  writeFileSync(join(repo, "file.txt"), "panel later edit\n");
  await page.getByTestId("git-refresh").click();
  await expect(tracked.getByTestId("git-file-status")).toContainText("Staged + Unstaged");
  await expect(tracked.getByTestId("git-diff-staged-section")).toContainText("+panel edit");
  await expect(tracked.getByTestId("git-diff-working-section")).toContainText("+panel later edit");
  await page.getByTestId("git-commit-message").fill("Commit via terminal panel");
  await page.getByTestId("git-commit").click();
  await expect(page.getByTestId("git-status-file")).toHaveCount(2);
  await expect(page.getByTestId("git-panel-worktree").first()).toContainText("main");
  await page.getByTestId("terminal-task-link-toggle").click();
  await expect(page.getByTestId("terminal-copy-link")).toHaveCount(0);
  await page.getByTestId("git-link-task").selectOption(task.id);
  await page.getByTestId("git-link-save").click();
  const checkout = await apiGet<{ root: string }>(request, `/terminals/${terminal.id}/git/status`);
  await page.getByTestId("git-linked-task").click();
  await expect(page.getByTestId("task-git-links")).toContainText("main");
  await page.reload();
  await expect(page.getByTestId("task-git-links")).toContainText(checkout.root);
});

test("Git pane selects all, switches branches and worktrees, and shows the current PR", async ({
  page,
  request,
}) => {
  const local = mkdtempSync(join(tmpdir(), "orc-pw-git-ux-"));
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "test"],
  ])
    await git(local, ...args);
  writeFileSync(join(local, "a.txt"), "before\n");
  await git(local, "add", ".");
  await git(local, "commit", "-m", "initial");
  await git(local, "branch", "feature");
  const other = `${local}-other`;
  await git(local, "worktree", "add", "-b", "other", other);
  const terminal = await apiPost<{ id: string }>(request, "/terminals", {
    kind: "shell",
    cwd: local,
  });
  await page.route("**/api/terminals/*/git/github", async (route) => {
    const terminalId = new URL(route.request().url()).pathname.split("/")[3];
    const status = await apiGet<{ branch: string }>(request, `/terminals/${terminalId}/git/status`);
    await route.fulfill({
      json: {
        auth: "gh",
        login: "test",
        errors: [],
        truncated: false,
        items:
          status.branch === "feature"
            ? [
                {
                  repo: "test/repo",
                  number: 88,
                  title: "Feature PR",
                  url: "https://github.com/test/repo/pull/88",
                  kind: "pr",
                  state: "open",
                  branch: "feature",
                  assignees: [],
                  task_ids: [],
                },
              ]
            : [],
      },
    });
  });
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
  await page.goto(`/terminals/${terminal.id}`);
  await splitTerminalPane(page.getByTestId("workspace-pane").first(), "horizontal");
  await expect(page.getByTestId("terminal-git-toggle")).toHaveCount(0);
  const panel = page.getByTestId("terminal-git-panel");
  await expect(page.getByTestId("git-branch").filter({ hasText: "main" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.getByTestId("git-panel-worktree").filter({ hasText: "Current" })).toContainText(
    "main",
  );
  await page.getByTestId("git-checkout-toggle").click();
  await page.getByTestId("git-branch-select").selectOption("feature");
  await expect(page.getByTestId("git-branch").filter({ hasText: "feature" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.getByTestId("git-branch").first()).toContainText("feature");
  await expect(page.getByTestId("git-current-pr")).toContainText("Open PR #88: Feature PR");
  writeFileSync(join(local, "a.txt"), "after\n");
  writeFileSync(join(local, "b.txt"), "added\n");
  await page.getByTestId("git-refresh").click();
  await page.getByTestId("git-branch-select").selectOption("main");
  await expect(panel.getByRole("alert")).toContainText("Commit or stash");
  await expect(page.getByTestId("git-status-file")).toHaveCount(2);
  await page.getByTestId("git-select-all").check();
  await page.getByTestId("git-stage").click();
  await page.getByTestId("git-commit-message").fill("All changes");
  await expect(page.getByTestId("git-commit")).toBeEnabled();
  await page.getByTestId("git-commit").click();
  await expect(page.getByTestId("git-clean")).toBeVisible();
  const otherOption = page.getByTestId("git-panel-worktree").filter({ hasText: "other" });
  const otherValue = await otherOption.getAttribute("value");
  if (!otherValue) throw new Error("Missing worktree option value");
  await page.getByTestId("git-worktree-select").selectOption(otherValue);
  await expect.poll(() => new URL(page.url()).pathname).not.toBe(`/terminals/${terminal.id}`);
  await expect(page.getByTestId("workspace-pane")).toHaveCount(2);
  await expect(
    page
      .locator('[data-testid="workspace-pane"][data-kind="terminal"]')
      .getByTestId("pane-terminal"),
  ).toHaveAttribute("data-terminal-id", terminal.id);
  await expect(page.getByTestId("terminal-git-panel")).toContainText("other");
  await expect(page.getByTestId("git-panel-worktree").filter({ hasText: "Current" })).toContainText(
    other,
  );
  await expect(page.getByTestId("git-panel-worktree").first()).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.getByTestId("git-branch").first()).toContainText("other");
  await expect(page.getByTestId("git-branch-select")).toHaveValue("other");
  await expect(page.getByTestId("git-current-pr")).not.toContainText("Feature PR");
});

test("slice 4 GitHub board filtering, linking, creating task and reopening saved links", async ({
  page,
  request,
}) => {
  const task = await apiPost<{ id: string }>(request, "/tasks", {
    title: tid("github-task"),
  });
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
      tasks: {
        id: string;
        github_issue: string | null;
        github_pr: string | null;
      }[];
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
      json: {
        auth: "gh",
        login: "niradler",
        items,
        errors: [],
        truncated: false,
      },
    });
  });
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
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
