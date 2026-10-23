import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { API_SECRET, apiGet, apiPost } from "./_helpers";
import { test } from "./_terminal-fixture";

const head = "a".repeat(40);
const filePatch =
  "@@ -1,33 +1,33 @@\n export function title() {\n-  return 'Old name';\n+  return 'Friendly session name';\n }" +
  Array.from({ length: 30 }, (_, index) => `\n // Additional context ${index + 1}`).join("");
const rootComment = {
  id: 10,
  body: "Should the session name be trimmed?",
  user: { login: "reviewer" },
  html_url: "https://github.com/example/workspace/pull/94#discussion_r10",
  created_at: "2026-10-23T00:00:00Z",
  path: "src/session.ts",
  line: 2,
  side: "RIGHT",
};

for (const [theme, width] of [
  ["dark", 1440],
  ["light", 1440],
  ["dark", 390],
  ["light", 320],
] as const) {
  test(`should review local and PR changes, retain drafts and send explicit comments ${theme} ${width}`, async ({
    page,
    request,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const repo = mkdtempSync(join(tmpdir(), "orc-review-ui-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { timeout: 15000, windowsHide: true });
    git("init", "-b", "main");
    git("config", "user.name", "UI review");
    git("config", "user.email", "review@example.test");
    mkdirSync(join(repo, "src"));
    writeFileSync(
      join(repo, "src/session.ts"),
      "export function title() {\n  return 'Old name';\n}\n",
    );
    git("add", ".");
    git("commit", "-m", "baseline");
    writeFileSync(
      join(repo, "src/session.ts"),
      "export function title() {\n  return 'Friendly session name';\n}\n",
    );
    git("add", ".");
    writeFileSync(
      join(repo, "src/session.ts"),
      "export function title() {\n  return 'Friendly session name'.trim();\n}\n",
    );
    writeFileSync(join(repo, "src/launcher.ts"), "export const launcher = 'shell';\n");
    const terminal = await apiPost<{ id: string; pid: number }>(request, "/terminals", {
      kind: "shell",
      cwd: repo,
      host: null,
      name: "Session naming",
    });
    const writes: Record<string, unknown>[] = [];
    let currentHead = head;
    let failSend = true;
    let auth = "gh";
    let binary = false;
    let state = "open";
    await page.route("**/api/terminals/*/git/github", (route) =>
      route.fulfill({
        json: {
          auth,
          login: "niradler",
          errors: [],
          truncated: false,
          items: [
            {
              repo: "example/workspace",
              number: 94,
              title: "Friendly terminal sessions",
              url: "https://github.com/example/workspace/pull/94",
              kind: "pr",
              state: "open",
              branch: "main",
              assignees: [],
              task_ids: [],
              ci: {
                state: "success",
                total: 3,
                url: "https://github.com/example/workspace/pull/94/checks",
              },
            },
          ],
        },
      }),
    );
    await page.route("**/api/terminals/*/git/pulls/94", (route) =>
      route.fulfill({
        json: {
          repo: "example/workspace",
          number: 94,
          title: "Friendly terminal sessions",
          body: "Keep each session recognizable while several agents are running.",
          state,
          url: "https://github.com/example/workspace/pull/94",
          author: "niradler",
          head: currentHead,
          branch: "main",
          base: "master",
          changed_files: 2,
          files: [
            {
              filename: "src/session.ts",
              status: "modified",
              additions: 1,
              deletions: 1,
              patch: filePatch,
              patch_truncated: false,
            },
            {
              filename: "docs/session-guide.md",
              status: "added",
              additions: 1,
              deletions: 0,
              patch: binary ? undefined : "@@ -0,0 +1 @@\n+# Session names",
              patch_truncated: false,
            },
          ],
          comments: [rootComment],
          discussion: [
            {
              ...rootComment,
              id: 11,
              body: "Ready for a UI review.",
              path: undefined,
              line: undefined,
            },
          ],
          reviews: [],
          truncated: false,
        },
      }),
    );
    await page.route("**/api/terminals/*/git/pulls/94/comments", (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      if (failSend) {
        failSend = false;
        return route.fulfill({
          status: 409,
          json: { error: "The PR has new commits. Refresh before sending.", code: "PR_CHANGED" },
        });
      }
      writes.push(payload);
      return route.fulfill({ status: 204 });
    });
    await page.addInitScript(
      ({ secret, theme }) => {
        localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
        localStorage.setItem("orc_theme", theme);
      },
      { secret: API_SECRET, theme },
    );
    expect(
      (
        await request.patch("/api/settings", {
          headers: { Authorization: `Bearer ${API_SECRET}` },
          data: { theme },
        })
      ).ok(),
    ).toBe(true);
    await page.goto(`/terminals/${terminal.id}?project=all&view=git`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const local = page.getByTestId("terminal-git-panel");
    await expect(local.getByTestId("git-checkout-controls")).toBeHidden();
    await expect(local.getByTestId("git-diff-file")).toHaveCount(2);
    await expect(local.getByTestId("git-diff").first()).toContainText("Friendly session name");
    if (width === 1440) {
      const diff = await local.getByTestId("git-review-diffs").boundingBox();
      const commit = await local.getByTestId("git-commit-message").boundingBox();
      if (!diff || !commit) throw new Error("Missing review canvas");
      expect(diff.y).toBeLessThan(300);
      expect(commit.y).toBeGreaterThan(800);
      expect(commit.width).toBeGreaterThan(700);
      await expect(local.getByTestId("git-changed-files")).toBeVisible();
      await expect(local.getByTestId("git-changed-files")).toContainText("Staged");
      await expect(local.getByTestId("git-changed-files")).toContainText("Untracked");
    } else {
      await local.getByTestId("git-files-menu").click();
      await expect(local.getByTestId("git-changed-files")).toBeVisible();
      await local.getByTestId("git-change-entry").filter({ hasText: "launcher.ts" }).click();
      await expect(local.getByTestId("git-changed-files")).toBeHidden();
    }
    const taskIcon = local.getByTestId("terminal-task-link-toggle");
    await expect(taskIcon).toBeVisible();
    if (width < 640) {
      const toolbar = await local.locator(".git-review-toolbar").boundingBox();
      expect(toolbar?.height).toBeLessThanOrEqual(52);
    }
    await expect(taskIcon).toHaveAttribute("aria-label", "Link ORC task");
    expect(await taskIcon.textContent()).toBe("");
    await taskIcon.click();
    await expect(page.getByTestId("terminal-task-link-menu")).toBeVisible();
    await expect(page.getByTestId("git-link-task")).toHaveCSS("appearance", "none");
    await page.keyboard.press("Escape");
    await local.getByTestId("git-commit-message").fill("Keep this local commit draft");
    await page.screenshot({ path: testInfo.outputPath("git-local.png") });
    await local.getByTestId("git-checkout-toggle").click();
    await expect(local.getByTestId("git-checkout-controls")).toBeVisible();
    await expect(local.getByTestId("git-branch-select")).toHaveCSS("appearance", "none");
    await local.getByTestId("git-checkout-toggle").click();
    if (width === 1440) await page.getByTestId("pane-linked-pr").click();
    else await local.getByTestId("git-pr-mode").click();
    await expect(page).toHaveURL(/pr=94/);
    const pr = local.getByTestId("pr-review-panel");
    await expect(pr).toBeVisible();
    await page.goBack();
    await expect(pr).toBeHidden();
    await page.goForward();
    await expect(pr).toBeVisible();
    await expect(local.getByTestId("git-commit-message")).toBeHidden();
    await expect(pr.getByTestId("pr-diff").first()).toContainText("Friendly session name");
    await expect(pr.getByTestId("pr-file-diff")).toHaveCount(2);
    await pr.getByTestId("pr-diff-scroll").hover();
    await page.mouse.wheel(0, 2000);
    await expect(pr.getByTestId("pr-file-diff").last()).toBeInViewport();
    if (width === 1440)
      await pr.getByTestId("pr-file-entry").filter({ hasText: "session.ts" }).click();
    else await pr.getByTestId("pr-file-select").selectOption("src/session.ts");
    await expect(pr.getByTestId("pr-file-diff").first()).toBeInViewport();
    await expect(local.getByTestId("git-pr-browser")).toHaveAttribute(
      "href",
      "https://github.com/example/workspace/pull/94",
    );
    expect(writes).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("git-pr-review.png") });
    await pr.locator('[data-testid="pr-comment-line"][data-side="RIGHT"][data-line="2"]').click();
    const inline = pr.getByTestId("pr-inline-composer");
    await inline.getByTestId("pr-comment-input").fill("Please trim whitespace before saving.");
    await inline.getByTestId("pr-comment-send").click();
    await expect(inline.getByRole("alert")).toContainText("draft is retained");
    await expect(inline.getByTestId("pr-comment-input")).toHaveValue(
      "Please trim whitespace before saving.",
    );
    currentHead = "b".repeat(40);
    await pr.getByTestId("pr-refresh").click();
    await expect(inline.getByTestId("pr-comment-send")).toBeDisabled();
    await pr.locator('[data-testid="pr-comment-line"][data-side="RIGHT"][data-line="2"]').click();
    await inline.getByTestId("pr-comment-send").click();
    await expect
      .poll(() => writes)
      .toContainEqual({
        kind: "inline",
        head: currentHead,
        path: "src/session.ts",
        side: "RIGHT",
        line: 2,
        body: "Please trim whitespace before saving.",
      });
    await expect(inline).toHaveCount(0);
    await pr.getByTestId("pr-discussion-tab").click();
    const discussion = pr.getByTestId("pr-discussion-panel");
    await expect(discussion).toContainText("Ready for a UI review.");
    await discussion.getByTestId("pr-comment-input").fill("General PR comment draft");
    await local.getByTestId("git-local-mode").click();
    await expect(local.getByTestId("git-commit-message")).toHaveValue(
      "Keep this local commit draft",
    );
    await local.getByTestId("git-pr-mode").click();
    await expect(discussion.getByTestId("pr-comment-input")).toHaveValue(
      "General PR comment draft",
    );
    await discussion.getByTestId("pr-comment-send").click();
    await expect
      .poll(() => writes)
      .toContainEqual({ kind: "discussion", head: currentHead, body: "General PR comment draft" });
    await pr.getByTestId("pr-files-tab").click();
    await pr.getByTestId("pr-reply").click();
    const thread = pr.getByTestId("pr-review-thread");
    await thread.getByTestId("pr-comment-input").fill("Yes, covered in this change.");
    await thread.getByTestId("pr-comment-send").click();
    await expect
      .poll(() => writes)
      .toContainEqual({
        kind: "reply",
        head: currentHead,
        comment_id: 10,
        body: "Yes, covered in this change.",
      });
    await expect(thread.getByTestId("pr-comment-input")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect(pr.getByTestId("pr-diff").first()).not.toContainText(".trim()");
    expect(await apiGet(request, `/terminals/${terminal.id}`)).toMatchObject({
      pid: terminal.pid,
      status: "running",
    });

    binary = true;
    await pr.getByTestId("pr-refresh").click();
    if (width === 1440)
      await pr.getByTestId("pr-file-entry").filter({ hasText: "session-guide.md" }).click();
    else await pr.getByTestId("pr-file-select").selectOption("docs/session-guide.md");
    await expect(pr).toContainText("No text patch available");
    state = "closed";
    await pr.getByTestId("pr-refresh").click();
    await expect(pr).toContainText("Comments are read-only");
    await pr.getByTestId("pr-discussion-tab").click();
    await expect(discussion.getByTestId("pr-comment-input")).toHaveCount(0);
    expect(writes).toHaveLength(3);
    auth = "none";
    await page.reload();
    await expect(local.getByTestId("git-pr-mode")).toHaveCount(0);
    await expect(local.getByTestId("git-pr-browser")).toBeVisible();
    await page.route("**/api/terminals/*/git/github", (route) =>
      route.fulfill({
        json: { auth: "gh", login: "niradler", errors: [], truncated: false, items: [] },
      }),
    );
    await page.reload();
    await expect(local.getByTestId("git-pr-mode")).toHaveCount(0);
    await expect(local.getByTestId("git-pr-browser")).toHaveCount(0);

    expect((await request.get(`/api/terminals/${terminal.id}/git/pulls/94`)).status()).toBe(401);
    expect(
      (
        await request.post(`/api/terminals/${terminal.id}/git/pulls/94/comments`, {
          data: { kind: "discussion", head, body: "blocked" },
        })
      ).status(),
    ).toBe(401);
  });
}
