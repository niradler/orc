import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { API_SECRET, apiGet, apiPost } from "./_helpers";
import { test } from "./_terminal-fixture";

test("renderer startup preserves actions opened immediately after terminal focus", async ({
  page,
  request,
}) => {
  const terminal = await apiPost<{ id: string }>(request, "/terminals", {
    kind: "shell",
    host: null,
  });
  await page.addInitScript(() => {
    document.addEventListener("focusin", (event) => {
      if (
        !(event.target instanceof HTMLElement) ||
        !event.target.matches('[aria-label="Terminal input"]') ||
        document.documentElement.dataset.startupMenuOpened
      )
        return;
      document.documentElement.dataset.startupMenuOpened = "true";
      queueMicrotask(() => {
        const actions = document.querySelector<HTMLButtonElement>(
          '[data-testid="terminal-actions"]',
        );
        actions?.focus();
        actions?.click();
      });
    });
  });
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
  await page.goto(`/terminals/${terminal.id}?project=all`);
  await expect(page.locator("html")).toHaveAttribute("data-startup-menu-opened", "true");
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.getByTestId("terminal-actions-menu")).toBeVisible();
  await expect(page.getByTestId("terminal-rename")).toBeFocused();
});

for (const stage of ["open menu", "focused trigger"] as const) {
  test(`renderer startup preserves terminal actions: ${stage}`, async ({ page, request }) => {
    const terminal = await apiPost<{ id: string }>(request, "/terminals", {
      kind: "shell",
      host: null,
    });
    await page.addInitScript(() => {
      const compile = WebAssembly.compile.bind(WebAssembly);
      WebAssembly.compile = async (...args) => {
        document.documentElement.dataset.rendererWaiting = "true";
        await new Promise<void>((resolve) =>
          window.addEventListener("release-test-renderer", () => resolve(), { once: true }),
        );
        return compile(...args);
      };
    });
    await page.addInitScript(
      (secret) =>
        localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
      API_SECRET,
    );
    try {
      await page.goto(`/terminals/${terminal.id}?project=all`);
      await page.waitForFunction(() => document.documentElement.dataset.rendererWaiting === "true");
      if (stage === "open menu") {
        await page.getByTestId("terminal-actions").click();
        await expect(page.getByTestId("terminal-actions-menu")).toBeVisible();
      } else {
        await page.getByTestId("terminal-actions").focus();
        await expect(page.getByTestId("terminal-actions-menu")).toHaveCount(0);
      }
    } finally {
      await page.evaluate(() => window.dispatchEvent(new Event("release-test-renderer")));
    }
    await expect(
      page.getByTestId("terminal-viewport").getByRole("textbox", { name: "Terminal input" }).last(),
    ).toBeVisible();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    if (stage === "focused trigger") {
      await expect(page.getByTestId("terminal-actions")).toBeFocused();
      await page.getByTestId("terminal-actions").click();
    }
    await expect(page.getByTestId("terminal-actions-menu")).toBeVisible();
    await expect(page.getByTestId("terminal-rename")).toBeFocused();
  });
}

test("should show current PR CI states and hide unavailable CI", async ({ page, request }) => {
  const repo = mkdtempSync(join(tmpdir(), "orc-ci-states-"));
  execFileSync("git", ["-C", repo, "init", "-b", "main"], { timeout: 15000, windowsHide: true });
  const terminal = await apiPost<{ id: string }>(request, "/terminals", {
    kind: "shell",
    cwd: repo,
  });
  let state: "success" | "failure" | "pending" | null = "success";
  let auth = "gh";
  let hasPr = true;
  await page.route("**/api/terminals/*/git/github", (route) =>
    route.fulfill({
      json: {
        auth,
        login: "review",
        errors: [],
        truncated: false,
        items: hasPr
          ? [
              {
                repo: "example/workspace",
                number: 42,
                title: "CI state fixture",
                url: "https://github.com/example/workspace/pull/42",
                kind: "pr",
                state: "open",
                branch: "main",
                assignees: [],
                task_ids: [],
                ci: state
                  ? { state, total: 2, url: "https://github.com/example/workspace/pull/42/checks" }
                  : null,
              },
            ]
          : [],
      },
    }),
  );
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/terminals/${terminal.id}?project=all`);
  await expect(page.getByTestId("pane-ci-status")).toHaveText("CI passed");
  state = "failure";
  await page.reload();
  await expect(page.getByTestId("pane-ci-status")).toHaveText("CI failed");
  state = "pending";
  await page.reload();
  await expect(page.getByTestId("pane-ci-status")).toHaveText("CI pending");
  state = null;
  await page.reload();
  await expect(page.getByTestId("pane-linked-pr")).toBeVisible();
  await expect(page.getByTestId("pane-ci-status")).toHaveCount(0);
  state = "success";
  auth = "none";
  await page.reload();
  await expect(page.getByTestId("pane-linked-pr")).toBeVisible();
  await expect(page.getByTestId("pane-ci-status")).toHaveCount(0);
  auth = "gh";
  hasPr = false;
  await page.reload();
  await expect(page.getByTestId("pane-linked-pr")).toHaveCount(0);
  await expect(page.getByTestId("pane-ci-status")).toHaveCount(0);
});

test("should keep the terminal picker compact and reveal checkout links only with space", async ({
  page,
  request,
}) => {
  const repo = mkdtempSync(join(tmpdir(), "orc-pane-context-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { timeout: 15000, windowsHide: true });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  writeFileSync(join(repo, "README.md"), "# Workspace\n");
  git("add", ".");
  git("commit", "-m", "baseline");
  const terminal = await apiPost<{ id: string; pid: number }>(request, "/terminals", {
    kind: "shell",
    cwd: repo,
    name: "Workspace review",
  });
  const second = await apiPost<{ id: string }>(request, "/terminals", {
    kind: "shell",
    cwd: repo,
    name: "API checks",
  });
  await apiPost(request, "/tasks", {
    title: "Improve session visibility",
    git_repo: repo,
    git_worktree: repo,
    git_branch: "main",
  });
  await page.route(`**/api/terminals/*/git/github`, (route) =>
    route.fulfill({
      json: {
        auth: "gh",
        login: "review",
        errors: [],
        truncated: false,
        items: [
          {
            repo: "example/workspace",
            number: 42,
            title: "Workspace review",
            url: "https://github.com/example/workspace/pull/42",
            kind: "pr",
            state: "open",
            branch: "main",
            assignees: [],
            task_ids: [],
            ci: {
              state: "success",
              total: 3,
              url: "https://github.com/example/workspace/pull/42/checks",
            },
          },
        ],
      },
    }),
  );
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/terminals/${terminal.id}?project=all`);
  await expect(page.getByTestId("pane-linked-task")).toBeVisible();
  await expect(page.getByTestId("pane-linked-pr")).toBeVisible();
  await expect(page.getByTestId("pane-ci-status")).toHaveText("CI passed");
  await expect(page.getByTestId("pane-linked-pr")).toHaveAttribute(
    "href",
    "https://github.com/example/workspace/pull/42",
  );
  const picker = page.getByTestId("pane-terminal");
  const pickerBox = await picker.boundingBox();
  const splitBox = await page.getByTestId("pane-split-horizontal").boundingBox();
  if (!pickerBox || !splitBox) throw new Error("Missing pane controls");
  expect(pickerBox.width).toBeLessThanOrEqual(44);
  expect(splitBox.x - (pickerBox.x + pickerBox.width)).toBeLessThanOrEqual(8);
  await page.screenshot({ path: "../../output/playwright/terminal-compact-context.png" });
  await picker.click();
  await page.locator(`[data-command-id="terminal-${second.id}"]`).click();
  await expect(picker).toHaveAttribute("data-terminal-id", second.id);
  await expect(page.getByTestId("terminal-viewport")).toHaveCount(1);
  const info = await apiGet<{ pid: number; status: string }>(request, `/terminals/${terminal.id}`);
  expect(info.pid).toBe(terminal.pid);
  expect(info.status).toBe("running");
  await page.getByTestId("pane-split-horizontal").click();
  await expect(page.getByTestId("pane-linked-task").first()).toBeHidden();
  await expect(page.getByTestId("pane-linked-pr").first()).toBeHidden();
  await expect(page.getByTestId("pane-ci-status").first()).toBeHidden();
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(page.getByTestId("pane-terminal").last()).toBeVisible();
  await expect(page.getByTestId("pane-actions").last()).toBeVisible();
  await expect(page.getByTestId("pane-checkout").last()).toBeHidden();
  await page.screenshot({ path: "../../output/playwright/terminal-compact-mobile.png" });
});

test("should retain file tabs through view and split changes, focus panes and filter split diffs", async ({
  page,
  request,
}) => {
  const repo = mkdtempSync(join(tmpdir(), "orc-ui-review-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { timeout: 15000, windowsHide: true });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "b.ts"), "export const b = 1;\n");
  git("add", ".");
  git("commit", "-m", "baseline");
  writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
  git("add", "a.ts");
  writeFileSync(join(repo, "b.ts"), "export const b = 2;\n");
  const terminal = await apiPost<{ id: string; pid: number }>(request, "/terminals", {
    kind: "shell",
    cwd: repo,
    name: "Review workspace",
  });
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
  await page.goto(`/terminals/${terminal.id}?project=all`);
  await page.getByTestId("pane-view-files").click();
  await page.locator('[data-testid="file-entry"][data-path="a.ts"]').click();
  await page.locator('[data-testid="file-entry"][data-path="b.ts"]').click();
  await expect(page.getByTestId("file-tab")).toHaveCount(2);
  await page.getByTestId("pane-view-git").click();
  await page.getByTestId("pane-view-files").click();
  await expect(page.getByTestId("file-tab")).toHaveCount(2);
  await page.getByTestId("pane-split-horizontal").click();
  const files = page.getByTestId("workspace-pane").filter({ has: page.getByTestId("file-panel") });
  const changes = page
    .getByTestId("workspace-pane")
    .filter({ has: page.getByTestId("terminal-git-panel") });
  await expect(files.getByTestId("file-tab")).toHaveCount(2);
  await files.getByTestId("pane-focus").click();
  await expect(page.getByTestId("workspace-pane").filter({ visible: true })).toHaveCount(1);
  await files.getByTestId("pane-focus").click();
  await expect(page.getByTestId("workspace-pane").filter({ visible: true })).toHaveCount(2);
  await changes.getByTestId("git-file-filter").fill("a.ts");
  await expect(changes.getByTestId("git-diff-file")).toHaveCount(1);
  await changes.getByTestId("git-layout-split").click();
  await expect(changes.getByTestId("git-diff-side-by-side")).toContainText("export const a = 1;");
  await expect(changes.getByTestId("git-diff-side-by-side")).toContainText("export const a = 2;");
  await changes.getByTestId("git-change-filter").selectOption("working");
  await expect(changes.getByTestId("git-filter-empty")).toBeVisible();
  await changes.getByTestId("git-change-filter").selectOption("staged");
  await expect(files.getByTestId("file-editor-input")).toContainText("b = 2");
  await changes.getByTestId("git-layout-unified").click();
  await page.screenshot({ path: "../../output/playwright/terminal-workspace-review.png" });
  await changes.getByTestId("pane-focus").click();
  await changes.getByTestId("git-layout-split").click();
  await changes.getByTestId("git-checkout-toggle").click();
  const branchBox = await changes.getByTestId("git-branch-select").boundingBox();
  const commitBox = await changes.getByTestId("git-commit-message").boundingBox();
  if (!commitBox) throw new Error("Missing commit message field");
  expect(commitBox.width).toBeGreaterThan(320);
  const worktreeBox = await changes.getByTestId("git-worktree-select").boundingBox();
  const newWorktreeBox = await changes.getByTestId("git-add-worktree").boundingBox();
  if (!branchBox || !worktreeBox || !newWorktreeBox) throw new Error("Missing checkout controls");
  expect(branchBox.width).toBeLessThanOrEqual(256);
  expect(worktreeBox.width).toBeLessThanOrEqual(512);
  expect(Math.abs(worktreeBox.y - newWorktreeBox.y)).toBeLessThan(2);
  await expect(changes.getByTestId("git-add-worktree")).toHaveText("New worktree");
  await page.screenshot({ path: "../../output/playwright/terminal-git-desktop.png" });
  await changes.getByTestId("git-checkout-toggle").click();
  await changes.getByTestId("pane-focus").click();
  await changes.getByTestId("git-open-file").click();
  await expect(page.getByTestId("file-panel")).toHaveCount(2);
  const updated = await apiGet<{ pid: number; status: string }>(
    request,
    `/terminals/${terminal.id}`,
  );
  expect(updated.pid).toBe(terminal.pid);
  expect(updated.status).toBe("running");
});

test("multiplexer splits terminal, Git and file panes, resizes and restores them without stopping shells", async ({
  page,
  request,
}) => {
  const repo = mkdtempSync(join(tmpdir(), "orc-panes-"));
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "test"],
  ])
    execFileSync("git", ["-C", repo, ...args], {
      timeout: 15_000,
      windowsHide: true,
    });
  writeFileSync(join(repo, "hello.txt"), "workspace preview\n");
  mkdirSync(join(repo, "src", "nested"), { recursive: true });
  writeFileSync(join(repo, "src", "nested", "example.ts"), "export const example = 42;\n");
  writeFileSync(join(repo, "binary.bin"), Buffer.from([0, 1, 2]));
  execFileSync("git", ["-C", repo, "add", "."], { timeout: 15_000 });
  execFileSync("git", ["-C", repo, "commit", "-m", "init"], {
    timeout: 15_000,
  });
  const first = await apiPost<{ id: string }>(request, "/terminals", {
    kind: "shell",
    cwd: repo,
  });
  const second = await apiPost<{ id: string }>(request, "/terminals", {
    kind: "shell",
    cwd: repo,
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
  await page.goto(`/terminals/${first.id}`);
  await expect(page.getByTestId("terminal-viewport")).toHaveCount(1);
  await page.getByTestId("pane-split-horizontal").click();
  await expect(page.getByTestId("workspace-pane")).toHaveCount(2);
  const git = page
    .getByTestId("workspace-pane")
    .filter({ has: page.getByTestId("terminal-git-panel") });
  await expect(git).toContainText("main");
  const divider = page.getByTestId("workspace-resize");
  const before = await page.getByTestId("workspace-pane").first().boundingBox();
  const rect = await divider.boundingBox();
  if (!before || !rect) throw new Error("Missing split geometry");
  await page.mouse.move(rect.x + 3, rect.y + 50);
  await page.mouse.down();
  await page.mouse.move(rect.x + 90, rect.y + 50, { steps: 6 });
  await page.mouse.up();
  expect((await page.getByTestId("workspace-pane").first().boundingBox())?.width).toBeGreaterThan(
    before.width + 50,
  );
  await git.getByTestId("pane-split-vertical").click();
  await expect(page.getByTestId("workspace-pane")).toHaveCount(3);
  const files = page.getByTestId("workspace-pane").filter({ has: page.getByTestId("file-panel") });
  const rootFolder = files.getByTestId("files-root");
  await expect(rootFolder).toHaveAttribute("aria-expanded", "true");
  await rootFolder.click();
  await expect(files.getByTestId("file-entry")).toHaveCount(0);
  await rootFolder.focus();
  await rootFolder.press("ArrowRight");
  await expect(rootFolder).toHaveAttribute("aria-expanded", "true");
  const sourceFolder = files.getByTestId("file-entry").filter({ hasText: /^src$/ });
  await expect(sourceFolder).toHaveAttribute("aria-expanded", "false");
  await sourceFolder.click();
  await expect(sourceFolder).toHaveAttribute("aria-expanded", "true");
  await files
    .getByTestId("file-entry")
    .filter({ hasText: /^nested$/ })
    .click();
  const example = files.locator('[data-testid="file-entry"][data-path="src/nested/example.ts"]');
  await example.click();
  await expect(files.getByTestId("file-preview")).toContainText("example = 42");
  await expect(files.getByTestId("file-editor-input")).toBeVisible();
  await expect(example).toHaveAttribute("aria-current", "true");
  await example.focus();
  await example.press("ArrowLeft");
  await expect(files.getByTestId("file-entry").filter({ hasText: /^nested$/ })).toBeFocused();
  await expect(files.getByTestId("file-entry").filter({ hasText: /^hello.txt$/ })).toBeVisible();
  await files.screenshot({ path: "../../output/playwright/files-tree.png" });
  await page.setViewportSize({ width: 2400, height: 1000 });
  const treeBounds = await files.getByTestId("files-tree").boundingBox();
  const previewBounds = await files.getByTestId("file-preview").boundingBox();
  if (!treeBounds || !previewBounds) throw new Error("Missing file explorer geometry");
  expect(previewBounds.x).toBeGreaterThanOrEqual(treeBounds.x + treeBounds.width);
  await files.screenshot({
    path: "../../output/playwright/files-tree-wide.png",
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await files.getByTestId("files-refresh").click();
  await expect(example).toBeVisible();
  await sourceFolder.click();
  await expect(example).toHaveCount(0);
  await expect(files.getByTestId("file-preview")).toContainText("example = 42");
  await sourceFolder.click();
  await expect(example).toBeVisible();
  await files.getByTestId("files-collapse").click();
  await expect(example).toHaveCount(0);
  await files
    .getByTestId("file-entry")
    .filter({ hasText: /^binary.bin$/ })
    .click();
  await expect(files).toContainText("Binary file; text preview unavailable.");
  await files.getByTestId("file-preview-close").click();
  await expect(files.getByTestId("file-preview-close")).toHaveCount(0);
  await files.getByTestId("file-entry").filter({ hasText: "hello.txt" }).click();
  await expect(files.getByTestId("file-preview")).toContainText("workspace preview");
  await files.getByTestId("pane-view-terminal").click();
  await page
    .getByTestId("workspace-pane")
    .filter({ has: page.getByTestId("terminal-viewport") })
    .nth(1)
    .getByTestId("pane-terminal")
    .click();
  await page.locator(`[data-command-id="terminal-${second.id}"]`).click();
  await expect(page.getByTestId("terminal-viewport")).toHaveCount(2);
  await expect(files).toHaveCount(0);
  const terminals = page
    .getByTestId("workspace-pane")
    .filter({ has: page.getByTestId("terminal-viewport") });
  await expect(terminals.nth(1).getByTestId("pane-terminal")).toHaveAttribute(
    "data-terminal-id",
    second.id,
  );
  await terminals.nth(1).getByTestId("pane-view-files").click();
  await page.reload();
  await expect(page.getByTestId("workspace-pane")).toHaveCount(3);
  await expect(page.getByTestId("file-panel")).toBeVisible();
  await page.getByTestId("workspace-resize").first().focus();
  const saved = Number(
    await page.getByTestId("workspace-resize").first().getAttribute("aria-valuenow"),
  );
  await page.getByTestId("workspace-resize").first().press("ArrowLeft");
  await expect(page.getByTestId("workspace-resize").first()).toHaveAttribute(
    "aria-valuenow",
    String(saved - 5),
  );
  await page
    .getByTestId("workspace-pane")
    .filter({ has: page.getByTestId("file-panel") })
    .getByTestId("pane-close")
    .click();
  await expect(page.getByTestId("workspace-pane")).toHaveCount(2);
  const info = await apiGet<{ terminals: { id: string; status: string }[] }>(request, "/terminals");
  expect(info.terminals.find((terminal) => terminal.id === second.id)?.status).toBe("running");
  await page.getByTestId("chat-open-button").click();
  const chat = page.getByTestId("chat-panel");
  const width = (await chat.boundingBox())?.width ?? 0;
  await page.getByTestId("chat-panel-resize").focus();
  await page.getByTestId("chat-panel-resize").press("ArrowLeft");
  expect((await chat.boundingBox())?.width).toBe(width + 16);
  expect(errors).toEqual([]);
});

test("should edit, save and reopen text files while preserving drafts and rejecting disk conflicts", async ({
  page,
  request,
}) => {
  const repo = mkdtempSync(join(tmpdir(), "orc-editor-"));
  execFileSync("git", ["-C", repo, "init", "-b", "main"], {
    timeout: 15_000,
    windowsHide: true,
  });
  writeFileSync(join(repo, "example.ts"), "export const answer = 42;\r\n");
  writeFileSync(join(repo, "other.txt"), "another file\n");
  writeFileSync(join(repo, "guide.md"), "# Terminal Markdown\nOriginal document.\n");
  const terminal = await apiPost<{ id: string }>(request, "/terminals", {
    kind: "shell",
    cwd: repo,
  });
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
  await page.goto(`/terminals/${terminal.id}`);
  await page.getByTestId("pane-view-files").click();
  await page.locator('[data-testid="file-entry"][data-path="example.ts"]').click();
  const input = page.getByTestId("file-editor-input");
  await expect(input).toBeVisible();
  await input.click();
  await input.press("ControlOrMeta+a");
  await page.keyboard.insertText("export const answer = 7;\n");
  await expect(page.getByTestId("file-save-status")).toHaveText("Unsaved changes");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator('[data-testid="file-entry"][data-path="other.txt"]').click();
  await expect(input).toContainText("answer = 7");
  await page.getByTestId("pane-view-git").click();
  await page.getByTestId("pane-view-files").click();
  await page.locator('[data-testid="file-entry"][data-path="example.ts"]').click();
  await expect(input).toContainText("answer = 7");
  await expect(page.getByTestId("file-save-status")).toHaveText("Unsaved changes");
  await input.press("ControlOrMeta+s");
  await expect(page.getByTestId("file-save-status")).toHaveText("Saved");
  const readFile = async () =>
    await apiGet<{ content: string }>(request, `/terminals/${terminal.id}/files?path=example.ts`);
  expect((await readFile()).content).toBe("export const answer = 7;\r\n");
  await page.reload();
  await page.locator('[data-testid="file-entry"][data-path="example.ts"]').click();
  await expect(input).toContainText("answer = 7");
  await page.getByRole("button", { name: "Word wrap", exact: true }).click();
  await expect(page.getByRole("button", { name: "Word wrap", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "Find in file", exact: true }).click();
  await expect(page.locator(".cm-search")).toBeVisible();
  await input.click();
  await input.press("ControlOrMeta+a");
  await page.keyboard.insertText("export const answer = 8;\n");
  writeFileSync(join(repo, "example.ts"), "export const answer = 99;\r\n");
  await page.getByTestId("file-save").click();
  await expect(page.getByRole("alert")).toContainText("File changed on disk");
  expect((await readFile()).content).toBe("export const answer = 99;\r\n");
  await expect(input).toContainText("answer = 8");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTestId("file-reload").click();
  await expect(input).toContainText("answer = 99");
  await expect(page.getByTestId("file-save-status")).toHaveText("Saved");
  await page.screenshot({
    path: "../../output/playwright/file-editor-save-reopen.png",
  });
  await page.locator('[data-testid="file-entry"][data-path="guide.md"]').click();
  await page.getByTestId("markdown-mode-edit").click();
  await input.fill("# Terminal Markdown\nSaved from expanded view.\n");
  await page.getByTestId("markdown-expand").click();
  await page.getByTestId("file-save").click();
  await expect(page.getByTestId("file-save-status")).toHaveText("Saved");
  expect(readFileSync(join(repo, "guide.md"), "utf8")).toContain("Saved from expanded view");
  await input.fill("# Terminal Markdown\nMy draft in fullscreen.\n");
  writeFileSync(join(repo, "guide.md"), "# Terminal Markdown\nConcurrent external edit.\n");
  await page.getByTestId("file-save").click();
  await expect(page.getByRole("alert")).toContainText("File changed on disk");
  await expect(input).toContainText("My draft in fullscreen");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTestId("file-reload").click();
  await expect(input).toContainText("Concurrent external edit");
  await page.getByTestId("markdown-expand").click();
});
