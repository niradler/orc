import { expect, type Page, test } from "@playwright/test";
import { API_SECRET } from "./_helpers";
import { HOME, mockSessionHome } from "./_session-home-demo";

const FOLDER = "/home/demo/acme-shop";

/** Minimal Electron preview bridge plus the demo session's preview/git routes. */
async function mockPreviewBridge(page: Page) {
  await page.addInitScript((secret) => {
    localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
    const subscribe = () => () => {};
    Object.defineProperty(window, "orcDesktop", {
      value: {
        notify: () => {},
        onOpen: () => () => {},
        preview: {
          profiles: async () => [],
          selectProfile: async () => null,
          onProfiles: subscribe,
          restore: async () => null,
          chatPermission: async () => false,
          onBrowser: subscribe,
          onOpen: subscribe,
          allow: async () => {},
          dirty: async () => {},
          bounds: async () => {},
          preferences: async () => ({ agentBrowserControl: true, openLinksIn: "preview" }),
          onPreferences: subscribe,
          setPreferences: async (value: unknown) => value,
          pick: async () => null,
        },
      },
    });
  }, API_SECRET);
  await page.route("**/api/desktop-preview/session?**", (r) =>
    r.fulfill({ json: { id: HOME.chatA, cwd: FOLDER, host: null, projectId: null } }),
  );
  await page.route("**/api/desktop-preview/clients", (r) =>
    r.fulfill({ json: { client_id: "e2e-preview", lease: "e2e-lease" } }),
  );
  await page.route("**/api/desktop-preview/clients/*/requests", (r) =>
    r.fulfill({ json: { requests: [] } }),
  );
  await page.route("**/api/desktop-preview/clients/*/close", (r) => r.fulfill({ json: {} }));
  await page.route("**/api/desktop-preview/file?**", (r) =>
    r.fulfill({
      json: {
        kind: "text",
        path: "src/cart/total.ts",
        root: FOLDER,
        host: null,
        content: [
          "export function total(items: Item[]) {",
          "  return Math.round(items.reduce((sum, item) => sum + item.price, 0) * 100) / 100;",
          "}",
        ].join("\n"),
        editable: true,
      },
    }),
  );
  await page.route(`**/api/terminals/${HOME.terminal}/git/worktrees`, (r) =>
    r.fulfill({
      json: {
        root: FOLDER,
        worktrees: [
          {
            path: FOLDER,
            branch: "fix/cart-rounding",
            head: null,
            main: true,
            dirty: true,
            detached: false,
            locked: false,
            prunable: false,
          },
        ],
      },
    }),
  );
}

async function openChanges(page: Page) {
  await page.getByTestId("chat-preview-toggle").click();
  await expect(page.getByTestId("desktop-preview-panel")).toBeVisible();
  await page.getByTestId("preview-changes-tab").click();
}

for (const width of [1440, 390])
  test.describe(`preview changes at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("shows the session's working diff, opens a file and sends it to the composer", async ({
      page,
    }) => {
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

      // Sending to the composer keeps the draft and reveals the conversation.
      await page.getByTestId("preview-changes-tab").click();
      await panel.getByTestId("git-send-to-composer").click();
      await expect(page.getByTestId("chat-input")).toHaveValue(
        /Review the changes in `src\/cart\/total\.ts`/,
      );
      if (width < 768) await expect(page.getByTestId("desktop-preview-panel")).toHaveCount(0);
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
