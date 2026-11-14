import { expect, type Page, test } from "@playwright/test";
import { HOME, mockSessionHome } from "./_session-home-demo";

/** Review set for the mobile chat redesign PR. Captured from the isolated demo
 *  fixture, never a real workspace. Run: bun packages/web/scripts/run-e2e.ts _mobile-chat-review */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function mockInspectorData(page: Page) {
  await page.route(`**/api/terminals/${HOME.terminal}/files?**`, (route) => {
    const path = new URL(route.request().url()).searchParams.get("path") ?? "";
    if (path === "package.json")
      return route.fulfill({
        json: {
          root: "/home/demo/acme-shop",
          path,
          entries: null,
          content:
            '{\n  "name": "acme-shop",\n  "version": "2.4.1",\n  "scripts": {\n    "dev": "vite",\n    "build": "tsc && vite build",\n    "test": "vitest run"\n  }\n}\n',
          binary: false,
          truncated: false,
        },
      });
    if (path === "src")
      return route.fulfill({
        json: {
          root: "/home/demo/acme-shop",
          path,
          entries: [
            { name: "cart", path: "src/cart", directory: true },
            { name: "checkout", path: "src/checkout", directory: true },
            { name: "main.tsx", path: "src/main.tsx", directory: false },
          ],
          content: null,
          binary: false,
          truncated: false,
        },
      });
    return route.fulfill({
      json: {
        root: "/home/demo/acme-shop",
        path,
        entries: [
          { name: "src", path: "src", directory: true },
          { name: "package.json", path: "package.json", directory: false },
          { name: "README.md", path: "README.md", directory: false },
        ],
        content: null,
        binary: false,
        truncated: false,
      },
    });
  });
  await page.route(`**/api/terminals/${HOME.terminal}/git/pulls/418`, (route) =>
    route.fulfill({
      json: {
        repo: "acme/shop",
        number: 418,
        title: "Round cart totals to cents",
        body: "Fixes the rounding drift at checkout by working in integer cents.",
        state: "open",
        url: "https://github.com/acme/shop/pull/418",
        author: "demo",
        head: "b7e2c9a4d1f0e8b6a5c3d2e1f0a9b8c7d6e5f4a3",
        branch: "fix/cart-rounding",
        base: "main",
        changed_files: 1,
        files: [
          {
            filename: "src/cart/total.ts",
            status: "modified",
            additions: 1,
            deletions: 1,
            patch:
              "@@ -1,3 +1,3 @@\n export function total(items: Item[]) {\n-  return items.reduce((sum, item) => sum + item.price, 0);\n+  return Math.round(items.reduce((sum, item) => sum + item.price, 0) * 100) / 100;\n }",
            patch_truncated: false,
          },
        ],
        comments: [],
        discussion: [],
        reviews: [],
        truncated: false,
      },
    }),
  );
  await page.route(`**/api/terminals/${HOME.terminal}/git/worktrees`, (route) =>
    route.fulfill({
      json: {
        root: "/home/demo/acme-shop",
        worktrees: [
          {
            path: "/home/demo/acme-shop",
            branch: "fix/cart-rounding",
            dirty: true,
            head: "b7e2c9a",
          },
        ],
      },
    }),
  );
}

async function setTheme(page: Page, theme: "dark" | "light") {
  await page.addInitScript((value) => localStorage.setItem("orc_theme", value), theme);
}

for (const theme of ["dark", "light"] as const) {
  test(`mobile chat review set (${theme})`, async ({ page }, testInfo) => {
    await setTheme(page, theme);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const data = await mockSessionHome(page);
    data.chats[0].projectId = "home-project";
    await page.route(/\/api\/projects(\?.*)?$/, (route) =>
      route.fulfill({
        json: {
          projects: [
            { id: "home-project", name: "Shop", status: "active", scope: "/home/demo/acme-shop" },
          ],
          total: 1,
        },
      }),
    );
    await mockInspectorData(page);
    const shot = (name: string) =>
      page.screenshot({ path: testInfo.outputPath(`mobile-${name}-${theme}.png`) });

    await page.goto(`/chat?project=all&chatThread=${HOME.chatA}`);
    await expect(page.getByText("Here is the checkout plan.").first()).toBeVisible();
    await shot("chat");

    await page.getByTestId("chat-sessions-button").click();
    await expect(page.getByTestId("chat-sessions-dialog")).toBeVisible();
    await expect(
      page
        .getByTestId("chat-sessions-dialog")
        .getByTestId("chat-session-list")
        .locator("[data-history-id]"),
    ).toHaveCount(4);
    await shot("sessions");
    await page.getByTestId("session-navigation-projects").click();
    const group = page
      .getByTestId("session-project-list")
      .getByTestId("session-project-toggle")
      .first();
    if ((await group.count()) > 0) await group.click();
    await shot("sessions-projects");
    await page.getByTestId("session-navigation-recents").click();
    await page.keyboard.press("Escape");

    await page.getByTestId("session-inspector-toggle").click();
    await expect(page.getByTestId("session-inspector")).toBeVisible();
    await expect(page.getByTestId("session-inspector-pull-request")).toContainText("#418");
    await shot("inspector-overview");

    await page.getByTestId("session-inspector-tab-diff").click();
    await expect(page.getByTestId("terminal-git-panel")).toBeVisible();
    await expect(page.getByRole("button", { name: /src\/cart\/total\.ts Modified/ })).toBeVisible();
    await shot("inspector-changes");

    await page.getByTestId("session-inspector-tab-pr").click();
    await expect(page.getByTestId("pr-review-panel")).toContainText("Round cart totals to cents");
    await shot("inspector-pr");

    await page.getByTestId("session-inspector-tab-files").click();
    await expect(page.getByTestId("file-panel")).toBeVisible();
    await page.getByTestId("file-entry").filter({ hasText: "package.json" }).click();
    await expect(page.locator(".cm-content")).toContainText("acme-shop");
    await shot("inspector-files");
    await page.keyboard.press("Escape");

    await page.getByTestId("session-drawer-toggle").click();
    await expect(page.getByTestId("session-drawer")).toBeVisible();
    await shot("terminal");
  });
}

test("desktop chat stays unchanged (dark)", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setTheme(page, "dark");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockSessionHome(page);
  await mockInspectorData(page);
  await page.goto(`/chat?project=all&chatThread=${HOME.chatA}`);
  await expect(page.getByTestId("chat-session-sidebar")).toBeVisible();
  await page.getByTestId("session-inspector-toggle").click();
  await expect(page.getByTestId("session-inspector")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("desktop-chat-dark.png") });
});
