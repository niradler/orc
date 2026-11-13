import { expect, type Page, test } from "@playwright/test";
import { PREVIEW_FOLDER as FOLDER, mockPreviewBridge } from "./_preview-demo";
import { HOME, mockSessionHome } from "./_session-home-demo";

async function openChanges(page: Page) {
  await page.getByTestId("chat-preview-toggle").click();
  await expect(page.getByTestId("desktop-preview-panel")).toBeVisible();
  await page.getByTestId("preview-changes-tab").click();
}

for (const width of [1440, 390])
  test.describe(`preview changes at ${width}px`, () => {
    test.use({
      viewport: { width, height: 900 },
      permissions: ["clipboard-read", "clipboard-write"],
    });

    test("shows the session's working diff, opens a file and copies its path", async ({ page }) => {
      await mockSessionHome(page);
      await mockPreviewBridge(page);
      await page.goto(`/chat?project=all&chatThread=${HOME.chatA}`);
      await openChanges(page);
      const panel = page.getByTestId("desktop-preview-panel");
      await expect(panel.getByTestId("terminal-git-panel")).toBeVisible();
      await expect(panel.getByTestId("git-changes-summary")).toHaveText("1");
      await expect(panel.getByTestId("git-change-entry")).toHaveAttribute(
        "data-path",
        "src/cart/total.ts",
      );
      await expect(panel.getByTestId("git-diff-working-section")).toContainText("Math.round");
      // Working tree only: PR review mode stays out of the preview panel.
      await expect(panel.getByTestId("git-pr-mode")).toHaveCount(0);
      await expect(panel.getByTestId("git-pr-browser")).toHaveCount(0);

      // Long guidance lives in the help popover: focus opens it, Escape dismisses it.
      await panel.getByTestId("preview-changes-help").focus();
      await expect(page.getByTestId("preview-changes-help-content")).toBeVisible();
      await expect(page.getByTestId("preview-changes-help-content")).toContainText(
        "working-tree changes",
      );
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("preview-changes-help-content")).toHaveCount(0);

      // The changed file opens in the panel's own editor tab.
      await panel.getByTestId("git-open-file").click();
      await expect(panel.getByTestId("preview-file-editor")).toBeVisible();
      await expect(panel.getByTestId("preview-editor-input")).toContainText("Math.round");

      // The copy icon puts the changed file's path on the clipboard and confirms it.
      await page.getByTestId("preview-changes-tab").click();
      await panel.getByTestId("git-copy-path").first().click();
      await expect(panel.getByTestId("git-copy-path").first()).toHaveAttribute(
        "aria-label",
        "Copied src/cart/total.ts",
      );
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("src/cart/total.ts");
      await expect(panel).toBeVisible();
    });

    test("quiet empty state with an open-terminal hint when no terminal matches", async ({
      page,
    }) => {
      const { terminal } = await mockSessionHome(page);
      await mockPreviewBridge(page);
      let created = false;
      await page.route(/\/api\/terminals(\?.*)?$/, (r) => {
        if (r.request().method() === "POST") {
          created = true;
          return r.fulfill({ json: terminal });
        }
        return r.fulfill({
          json: {
            enabled: true,
            ready: true,
            reason: null,
            launchers: ["shell"],
            host: null,
            terminals: created ? [terminal] : [],
          },
        });
      });
      await page.goto(`/chat?project=all&chatThread=${HOME.chatA}`);
      await openChanges(page);
      const empty = page.getByTestId("preview-changes-empty");
      await expect(empty).toBeVisible();
      await expect(empty).toContainText("No terminal is running");
      await expect(empty.getByRole("alert")).toHaveCount(0);
      await expect(page.getByTestId("preview-changes-help")).toBeVisible();
      await empty.getByTestId("preview-changes-open-terminal").click();
      await expect(page.getByTestId("terminal-git-panel")).toBeVisible();
      await expect(page.getByTestId("preview-changes-empty")).toHaveCount(0);
    });
  });

test("wide preview panel splits the file list and diff; drafts survive tab switches", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("orc_preview_width", "860"));
  await mockSessionHome(page);
  await mockPreviewBridge(page);
  await page.goto(`/chat?project=all&chatThread=${HOME.chatA}`);
  await openChanges(page);
  const panel = page.getByTestId("desktop-preview-panel");
  await expect(panel.getByTestId("git-changed-files")).toBeVisible();
  await expect(panel.getByTestId("git-files-menu")).toBeHidden();
  await expect(panel.getByTestId("git-files-toggle")).toBeVisible();

  // The commit draft and filters stay while another tab is shown.
  await panel.getByTestId("git-commit-message").fill("demo: round cart totals");
  await panel.getByTestId("git-file-filter").fill("total");
  await page.getByTestId("preview-browser-tab").click();
  await expect(panel.getByTestId("desktop-preview-browser-surface")).toBeVisible();
  await page.getByTestId("preview-changes-tab").click();
  await expect(panel.getByTestId("git-commit-message")).toHaveValue("demo: round cart totals");
  await expect(panel.getByTestId("git-file-filter")).toHaveValue("total");
});

test("default-width preview panel combines the file list behind the files toggle", async ({
  page,
}) => {
  await mockSessionHome(page);
  await mockPreviewBridge(page);
  await page.goto(`/chat?project=all&chatThread=${HOME.chatA}`);
  await openChanges(page);
  const panel = page.getByTestId("desktop-preview-panel");
  await expect(panel.getByTestId("git-files-menu")).toBeVisible();
  await expect(panel.getByTestId("git-changed-files")).toBeHidden();
  await panel.getByTestId("git-files-menu").click();
  await expect(panel.getByTestId("git-changed-files")).toBeVisible();
  await panel.getByTestId("git-change-entry").click();
  await expect(panel.getByTestId("git-changed-files")).toBeHidden();
  await expect(panel.getByTestId("git-diff-working-section")).toContainText("Math.round");
});

test("commit draft survives closing the panel and switching chats", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockSessionHome(page);
  await mockPreviewBridge(page);
  await page.goto(`/chat?project=all&chatThread=${HOME.chatA}`);
  await openChanges(page);
  const panel = page.getByTestId("desktop-preview-panel");
  await panel.getByTestId("git-commit-message").fill("demo: keep this draft");
  await panel.getByTestId("git-file-filter").fill("total");

  // Closing the panel unmounts the Changes host; the draft must survive it.
  await page.getByTestId("chat-preview-toggle").click();
  await expect(page.getByTestId("desktop-preview-panel")).toHaveCount(0);
  await page.getByTestId("chat-preview-toggle").click();
  await page.getByTestId("preview-changes-tab").click();
  await expect(panel.getByTestId("git-commit-message")).toHaveValue("demo: keep this draft");
  await expect(panel.getByTestId("git-file-filter")).toHaveValue("total");

  // Another chat in the same folder resolves the same terminal: the draft is
  // kept per terminal, not per chat tab.
  await page.getByTestId("chat-preview-toggle").click();
  await expect(page.getByTestId("desktop-preview-panel")).toHaveCount(0);
  const list = page.getByTestId("chat-session-sidebar").getByTestId("chat-session-list");
  await list.locator(`[data-history-id="chat:${HOME.chatB}"]`).locator("button").first().click();
  await expect(page.getByText("Three billing bugs are open.").first()).toBeVisible();
  await page.getByTestId("chat-preview-toggle").click();
  await page.getByTestId("preview-changes-tab").click();
  await expect(panel.getByTestId("git-commit-message")).toHaveValue("demo: keep this draft");
  await expect(panel.getByTestId("git-file-filter")).toHaveValue("total");
});

test("quiet no-session state when no chat session is selected", async ({ page }) => {
  await mockSessionHome(page);
  await mockPreviewBridge(page);
  await page.route("**/api/chat/threads", (r) => r.fulfill({ json: { threads: [] } }));
  await page.goto("/chat?project=all");
  await page.getByTestId("chat-preview-toggle").click();
  await expect(page.getByTestId("desktop-preview-panel")).toBeVisible();
  await page.getByTestId("preview-changes-tab").click();
  const empty = page.getByTestId("preview-changes-empty");
  await expect(empty).toContainText("Start or select a saved session");
  await expect(empty.getByRole("alert")).toHaveCount(0);
});

test("deleted files offer copy-path but not open-file", async ({ page }) => {
  await mockSessionHome(page);
  await mockPreviewBridge(page);
  await page.route(`**/api/terminals/${HOME.terminal}/git/status`, (r) =>
    r.fulfill({
      json: {
        root: FOLDER,
        branch: "fix/cart-rounding",
        files: [
          { path: "src/cart/total.ts", index: " ", working: "M", original: null },
          { path: "src/legacy/old.ts", index: "D", working: " ", original: null },
        ],
        branches: ["main", "fix/cart-rounding"],
      },
    }),
  );
  await page.goto(`/chat?project=all&chatThread=${HOME.chatA}`);
  await openChanges(page);
  const panel = page.getByTestId("desktop-preview-panel");
  const deleted = panel.locator('[data-testid="git-diff-file"][data-path="src/legacy/old.ts"]');
  await expect(deleted).toBeVisible();
  await expect(deleted.getByTestId("git-open-file")).toHaveCount(0);
  await expect(deleted.getByTestId("git-copy-path")).toBeVisible();
  const modified = panel.locator('[data-testid="git-diff-file"][data-path="src/cart/total.ts"]');
  await expect(modified.getByTestId("git-open-file")).toBeVisible();
});

test("a failed terminals load shows an error with retry, not the quiet empty state", async ({
  page,
}) => {
  await mockSessionHome(page);
  await mockPreviewBridge(page);
  await page.route(/\/api\/terminals(\?.*)?$/, (r) =>
    r.request().method() === "GET"
      ? r.fulfill({ status: 500, json: { error: "terminal list unavailable" } })
      : r.fallback(),
  );
  await page.goto(`/chat?project=all&chatThread=${HOME.chatA}`);
  await openChanges(page);
  const empty = page.getByTestId("preview-changes-empty");
  await expect(empty.getByRole("alert")).toContainText("Could not load terminals");
  await expect(empty.getByTestId("preview-changes-open-terminal")).toHaveCount(0);
  await expect(empty.getByTestId("preview-changes-retry-terminals")).toBeVisible();
});
