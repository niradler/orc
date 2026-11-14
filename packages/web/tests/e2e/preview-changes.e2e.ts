import { expect, type Page, test } from "@playwright/test";
import { PREVIEW_FOLDER as FOLDER, mockPreviewBridge } from "./_preview-demo";
import { HOME, mockSessionHome } from "./_session-home-demo";

const panelOf = (page: Page) => page.getByTestId("session-inspector");

async function openInspector(page: Page) {
  const toggle = page.getByTestId("session-inspector-toggle").filter({ visible: true });
  if (!(await panelOf(page).isVisible())) await toggle.click();
  await expect(panelOf(page)).toBeVisible();
}

async function openChanges(page: Page) {
  await openInspector(page);
  const tab = page.getByTestId("session-inspector-tab-diff");
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

for (const width of [1440, 390])
  test.describe(`inspector changes at ${width}px`, () => {
    test.use({
      viewport: { width, height: 900 },
      permissions: ["clipboard-read", "clipboard-write"],
    });

    test("shows the session's working diff and PR entry points, opens a file and copies its path", async ({
      page,
    }) => {
      await mockSessionHome(page);
      await mockPreviewBridge(page);
      await page.goto(`/chat?project=all&chatThread=${HOME.chatA}`);
      await openChanges(page);
      const panel = panelOf(page);
      await expect(panel.getByTestId("terminal-git-panel")).toBeVisible();
      await expect(panel.getByTestId("git-changes-summary")).toHaveText("1");
      await expect(panel.getByTestId("git-change-entry")).toHaveAttribute(
        "data-path",
        "src/cart/total.ts",
      );
      await expect(panel.getByTestId("git-diff-working-section")).toContainText("Math.round");
      // The inspector's Changes tab is the full review surface: PR mode and a GitHub link.
      await expect(panel.getByTestId("git-pr-mode")).toBeVisible();
      await expect(panel.getByTestId("git-pr-mode")).toContainText("PR #418");
      await expect(panel.getByTestId("git-pr-browser")).toHaveAttribute(
        "href",
        "https://github.com/acme/shop/pull/418",
      );

      // Long guidance lives in the help popover: focus opens it, Escape dismisses it.
      await panel.getByTestId("inspector-changes-help").focus();
      await expect(page.getByTestId("inspector-changes-help-content")).toBeVisible();
      await expect(page.getByTestId("inspector-changes-help-content")).toContainText(
        "working-tree changes",
      );
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("inspector-changes-help-content")).toHaveCount(0);

      // Open file moves to the inspector's Files tab with that file selected.
      await panel.getByTestId("git-open-file").click();
      await expect(page).toHaveURL(/inspector=files/);
      await expect(page.getByTestId("session-inspector-tab-files")).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(panel.getByTestId("file-editor")).toBeVisible();
      await expect(panel.getByTestId("file-preview")).toContainText("Math.round");

      // The copy icon puts the changed file's path on the clipboard and confirms it.
      await page.getByTestId("session-inspector-tab-diff").click();
      await panel.getByTestId("git-copy-path").first().click();
      await expect(panel.getByTestId("git-copy-path").first()).toHaveAttribute(
        "aria-label",
        "Copied src/cart/total.ts",
      );
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("src/cart/total.ts");
      await expect(panel).toBeVisible();
    });
  });

test("quiet Overview guidance when no terminal matches the session folder", async ({ page }) => {
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
  await openInspector(page);
  await expect(page.getByTestId("session-inspector-tab-diff")).toBeDisabled();
  const empty = page.getByTestId("session-inspector-git-empty");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("needs a running terminal");
  await expect(page.getByTestId("session-inspector-git-empty").getByRole("alert")).toHaveCount(0);

  // Opening a terminal makes the Changes tab available.
  await page.getByTestId("session-inspector-open-terminal").click();
  await expect(page.getByTestId("session-drawer")).toBeVisible();
  await page.getByTestId("session-drawer-open").click();
  await expect(page.getByTestId("session-inspector-tab-diff")).toBeEnabled();
  await page.getByTestId("session-inspector-tab-diff").click();
  await expect(panelOf(page).getByTestId("terminal-git-panel")).toBeVisible();
});

test("wide inspector splits the file list and diff; drafts survive tab switches", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem("orc_session_inspector_width", "860"));
  await mockSessionHome(page);
  await mockPreviewBridge(page);
  await page.goto(`/chat?project=all&chatThread=${HOME.chatA}`);
  await openChanges(page);
  const panel = panelOf(page);
  await expect(panel.getByTestId("git-changed-files")).toBeVisible();
  await expect(panel.getByTestId("git-files-menu")).toBeHidden();
  await expect(panel.getByTestId("git-files-toggle")).toBeVisible();

  // The commit draft and filters stay while another tab is shown.
  await panel.getByTestId("git-commit-message").fill("demo: round cart totals");
  await panel.getByTestId("git-file-filter").fill("total");
  await page.getByTestId("session-inspector-tab-files").click();
  await page.getByTestId("session-inspector-tab-diff").click();
  await expect(panel.getByTestId("git-commit-message")).toHaveValue("demo: round cart totals");
  await expect(panel.getByTestId("git-file-filter")).toHaveValue("total");
});

test("default-width inspector combines the file list behind the files toggle", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockSessionHome(page);
  await mockPreviewBridge(page);
  await page.goto(`/chat?project=all&chatThread=${HOME.chatA}`);
  await openChanges(page);
  const panel = panelOf(page);
  await expect(panel.getByTestId("git-files-menu")).toBeVisible();
  await expect(panel.getByTestId("git-changed-files")).toBeHidden();
  await panel.getByTestId("git-files-menu").click();
  await expect(panel.getByTestId("git-changed-files")).toBeVisible();
  await panel.getByTestId("git-change-entry").click();
  await expect(panel.getByTestId("git-changed-files")).toBeHidden();
  await expect(panel.getByTestId("git-diff-working-section")).toContainText("Math.round");
});

test("commit draft survives closing the inspector and switching chats", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockSessionHome(page);
  await mockPreviewBridge(page);
  await page.goto(`/chat?project=all&chatThread=${HOME.chatA}`);
  await openChanges(page);
  const panel = panelOf(page);
  await panel.getByTestId("git-commit-message").fill("demo: keep this draft");
  await panel.getByTestId("git-file-filter").fill("total");

  // Closing the panel unmounts the Changes host; the draft must survive it.
  await page.getByTestId("session-inspector-toggle").filter({ visible: true }).click();
  await expect(panelOf(page)).toHaveCount(0);
  await openChanges(page);
  await expect(panel.getByTestId("git-commit-message")).toHaveValue("demo: keep this draft");
  await expect(panel.getByTestId("git-file-filter")).toHaveValue("total");

  // Another chat in the same folder resolves the same terminal: the draft is
  // kept per terminal, not per chat tab. The list defaults to grouped Projects,
  // so switch to the flat Recents view first.
  const list = page.getByTestId("chat-session-sidebar").getByTestId("chat-session-list");
  await page.getByTestId("session-navigation-recents").click();
  await list.locator(`[data-history-id="chat:${HOME.chatB}"]`).locator("button").first().click();
  await expect(page.getByText("Three billing bugs are open.").first()).toBeVisible();
  await openChanges(page);
  await expect(panel.getByTestId("git-commit-message")).toHaveValue("demo: keep this draft");
  await expect(panel.getByTestId("git-file-filter")).toHaveValue("total");
});

test("quiet no-session state when no chat session is selected", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockSessionHome(page);
  await mockPreviewBridge(page);
  await page.route("**/api/chat/threads", (r) => r.fulfill({ json: { threads: [] } }));
  await page.goto("/chat?project=all");
  await openInspector(page);
  const empty = page.getByTestId("session-inspector-git-empty");
  await expect(empty).toContainText("needs a running terminal");
  await expect(page.getByTestId("session-inspector-folder")).toHaveCount(0);
  await expect(page.getByTestId("session-inspector-terminals-error")).toHaveCount(0);
});

test("deleted files offer copy-path but not open-file", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
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
  const panel = panelOf(page);
  const deleted = panel.locator('[data-testid="git-diff-file"][data-path="src/legacy/old.ts"]');
  await expect(deleted).toBeVisible();
  await expect(deleted.getByTestId("git-open-file")).toHaveCount(0);
  await expect(deleted.getByTestId("git-copy-path")).toBeVisible();
  const modified = panel.locator('[data-testid="git-diff-file"][data-path="src/cart/total.ts"]');
  await expect(modified.getByTestId("git-open-file")).toBeVisible();
});

test("a failed terminals load shows an error with retry in the Overview", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockSessionHome(page);
  await mockPreviewBridge(page);
  await page.route(/\/api\/terminals(\?.*)?$/, (r) =>
    r.request().method() === "GET"
      ? r.fulfill({ status: 500, json: { error: "terminal list unavailable" } })
      : r.fallback(),
  );
  await page.goto(`/chat?project=all&chatThread=${HOME.chatA}`);
  await openInspector(page);
  const error = page.getByTestId("session-inspector-terminals-error");
  await expect(error).toContainText("Could not load terminals");
  await expect(page.getByTestId("session-inspector-terminals-retry")).toBeVisible();
  await expect(page.getByTestId("session-inspector-open-terminal")).toHaveCount(0);
});
