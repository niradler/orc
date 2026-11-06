import { expect, type Page, test } from "@playwright/test";
import { HOME, mockSessionHome } from "./_session-home-demo";

const rowIds = [
  `chat:${HOME.chatA}`,
  `chat:${HOME.chatB}`,
  `native:${HOME.claudeLive}`,
  `native:${HOME.codexLive}`,
];

async function sessionList(page: Page, narrow: boolean) {
  if (narrow) {
    await page.getByTestId("chat-sessions-button").filter({ visible: true }).click();
    return page.getByTestId("chat-sessions-dialog").getByTestId("chat-session-list");
  }
  return page.getByTestId("chat-session-sidebar").getByTestId("chat-session-list");
}

const row = (list: ReturnType<Page["getByTestId"]>, id: string) =>
  list.locator(`[data-history-id="${id}"]`);

for (const width of [1440, 390])
  test.describe(`session home at ${width}px`, () => {
    const narrow = width < 1280;
    test.use({ viewport: { width, height: 900 } });

    test("lists chats, a terminal agent and an outside session with states and opens each", async ({
      page,
    }) => {
      await mockSessionHome(page);
      await page.goto(`/tasks?project=all&chat=full&chatThread=${HOME.chatA}`);
      await expect(page.getByText("Here is the checkout plan.").first()).toBeVisible();
      if (!narrow) {
        await expect(page.getByTestId("session-home")).toBeVisible();
        const sidebar = await page.getByTestId("workspace-sidebar").boundingBox();
        expect(sidebar?.width).toBeLessThanOrEqual(64);
      }

      let list = await sessionList(page, narrow);
      for (const id of rowIds) await expect(row(list, id)).toHaveCount(1);
      await expect(list.locator("[data-history-id]")).toHaveCount(4);
      await expect(row(list, `native:${HOME.claudeLive}`)).toHaveAttribute("data-state", "working");
      await expect(row(list, `native:${HOME.codexLive}`)).toHaveAttribute(
        "data-state",
        "needs-you",
      );
      await expect(
        row(list, `native:${HOME.claudeLive}`).getByTestId("chat-open-terminal"),
      ).toBeVisible();

      await row(list, `native:${HOME.claudeLive}`).getByTestId("chat-open-terminal").click();
      await expect(page).toHaveURL(new RegExp(`sessionTerminal=${HOME.terminal}`));
      await expect(page.getByTestId("session-terminal")).toBeVisible();
      await expect(page.getByTestId("chat-header-actions")).toBeHidden();

      list = await sessionList(page, narrow);
      await row(list, `chat:${HOME.chatB}`).locator("button").first().click();
      await expect(page.getByText("Three billing bugs are open.").first()).toBeVisible();
      await expect(page).not.toHaveURL(/sessionTerminal=/);
      await expect(page.getByTestId("session-terminal")).toBeHidden();

      list = await sessionList(page, narrow);
      await row(list, `native:${HOME.codexLive}`).getByTestId("chat-resume-live").click();
      await expect(page.getByText("Resumed.").first()).toBeVisible();
    });

    test("toggles the inspector and terminal drawer from the header and restores them on reload and Back", async ({
      page,
    }) => {
      await mockSessionHome(page);
      await page.goto(`/tasks?project=all&chat=full&sessionTerminal=${HOME.terminal}`);
      await expect(page.getByTestId("session-terminal")).toBeVisible();
      await expect(page.getByTestId("session-inspector")).toHaveCount(0);

      const inspectorToggle = page
        .getByTestId("session-inspector-toggle")
        .filter({ visible: true });
      await expect(inspectorToggle).toHaveAttribute("aria-pressed", "false");
      await inspectorToggle.click();
      await expect(page).toHaveURL(/inspector=overview/);
      const inspector = page.getByTestId("session-inspector");
      await expect(inspector).toBeVisible();
      await expect(inspector.getByTestId("session-inspector-host")).toContainText("local");
      await expect(inspector.getByTestId("session-inspector-folder")).toContainText(
        "/home/demo/acme-shop",
      );
      await expect(inspector.getByTestId("session-inspector-branch")).toContainText(
        "fix/cart-rounding",
      );
      await expect(inspector.getByTestId("session-inspector-changes")).toContainText("1 file");
      await expect(inspector.getByTestId("session-inspector-pull-request")).toContainText(
        "#418 Round cart totals to cents",
      );
      await inspector.getByTestId("session-inspector-tab-diff").click();
      await expect(page).toHaveURL(/inspector=diff/);
      await expect(
        inspector.getByRole("button", { name: /src\/cart\/total\.ts Modified/ }),
      ).toBeVisible();

      if (narrow) await page.keyboard.press("Escape");
      else {
        const drawerToggle = page.getByTestId("session-drawer-toggle");
        await expect(drawerToggle).toHaveAttribute("aria-pressed", "false");
        await drawerToggle.click();
        await expect(page).toHaveURL(/drawer=terminal/);
        await expect(page.getByTestId("session-drawer")).toBeVisible();
        await expect(page.getByTestId("session-drawer-open")).toBeVisible();
        await expect(drawerToggle).toHaveAttribute("aria-pressed", "true");

        await page.reload();
        await expect(page.getByTestId("session-terminal")).toBeVisible();
        await expect(page.getByTestId("session-inspector")).toBeVisible();
        await expect(page.getByTestId("session-inspector-tab-diff")).toHaveAttribute(
          "aria-selected",
          "true",
        );
        await expect(page.getByTestId("session-drawer")).toBeVisible();

        await page.goBack();
        await expect(page.getByTestId("session-drawer")).toHaveCount(0);
        await expect(page.getByTestId("session-inspector")).toBeVisible();
        return;
      }

      await expect(page).not.toHaveURL(/inspector=/);
      await page.getByTestId("session-drawer-toggle").filter({ visible: true }).click();
      await expect(page).toHaveURL(/drawer=terminal/);
      await expect(page.getByTestId("session-drawer")).toBeVisible();
      await page.reload();
      await expect(page.getByTestId("session-drawer")).toBeVisible();
      await page.goBack();
      await expect(page.getByTestId("session-drawer")).toHaveCount(0);
    });

    test("opens from Activity Sessions and leaving returns to that page", async ({ page }) => {
      await mockSessionHome(page);
      await page.goto("/sessions?project=all");
      const liveRow = page
        .getByTestId("live-session-row")
        .filter({ hasText: "Upgrade the payments SDK" });
      await liveRow.getByTestId("live-session-open-home").click();
      await expect(page.getByText("Resumed.").first()).toBeVisible();
      await expect(page).not.toHaveURL(/sessionLive=/);

      const list = await sessionList(page, narrow);
      await row(list, `chat:${HOME.chatA}`).locator("button").first().click();
      await expect(page.getByText("Here is the checkout plan.").first()).toBeVisible();

      await page
        .getByTestId(narrow ? "chat-close-button" : "chat-fullscreen-button")
        .filter({ visible: true })
        .click();
      await expect(page).toHaveURL(/\/sessions\?project=all$/);
      await expect(page.getByTestId("live-sessions")).toBeVisible();
    });
  });

test.describe("session home on desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("collapses the list to a rail that keeps every session reachable", async ({ page }) => {
    await mockSessionHome(page);
    await page.goto(`/tasks?project=all&chat=full&chatThread=${HOME.chatA}`);
    await expect(page.getByTestId("chat-session-sidebar")).toBeVisible();
    await page.getByTestId("session-list-collapse").click();
    await expect(page).toHaveURL(/sessionList=hide/);
    const rail = page.getByTestId("session-rail");
    await expect(rail).toBeVisible();
    await expect(page.getByTestId("chat-session-sidebar")).toHaveCount(0);
    await expect(rail.getByTestId("session-rail-item")).toHaveCount(4);
    await expect(rail.locator(`[data-history-id="native:${HOME.codexLive}"]`)).toHaveAttribute(
      "data-state",
      "needs-you",
    );
    await rail.locator(`[data-history-id="native:${HOME.claudeLive}"]`).click();
    await expect(page.getByTestId("session-terminal")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("session-rail")).toBeVisible();
    await page.getByTestId("session-list-expand").click();
    await expect(page.getByTestId("chat-session-sidebar")).toBeVisible();
  });

  test("opens a terminal agent from Terminals Sessions", async ({ page }) => {
    await mockSessionHome(page);
    await page.goto(`/terminals/${HOME.terminal}?project=all`);
    await page.getByTestId("terminals-open-home").click();
    await expect(page).toHaveURL(new RegExp(`chat=full&sessionTerminal=${HOME.terminal}`));
    await expect(page.getByTestId("session-terminal")).toBeVisible();
    await page.getByTestId("chat-fullscreen-button").click();
    await expect(page).toHaveURL(new RegExp(`/terminals/${HOME.terminal}\\?project=all$`));
  });
});
