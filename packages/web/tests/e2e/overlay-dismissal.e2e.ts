import { ChatSettingsSchema } from "@orc/core/chat";
import { expect, test } from "@playwright/test";
import { API_SECRET, gotoView } from "./_helpers";

for (const width of [320, 390, 1440]) {
  for (const theme of ["dark", "light"] as const) {
    test.describe(`overlay dismissal at ${width}px ${theme}`, () => {
      test.use({ viewport: { width, height: 900 }, hasTouch: width < 1000 });

      test.beforeEach(async ({ page, request }) => {
        const settings = await request.patch("/api/settings", {
          headers: { Authorization: `Bearer ${API_SECRET}` },
          data: { theme, chat: ChatSettingsSchema.parse({}) },
        });
        expect(settings.ok()).toBe(true);
        await page.route("**/api/chat/models?**", (route) =>
          route.fulfill({ json: { models: [], warning: null } }),
        );
        await page.route("**/api/ssh", (route) =>
          route.fulfill({ json: { host: null, hosts: [], supported: true } }),
        );
        await page.route("**/api/git/worktrees?**", (route) =>
          route.fulfill({
            json: {
              root: "/workspace/product",
              worktrees: [{ path: "/workspace/product", branch: "refs/heads/main", main: true }],
            },
          }),
        );
        await page.addInitScript((selectedTheme) => {
          localStorage.setItem("orc-theme", selectedTheme);
          localStorage.setItem(
            "orc_folder_history",
            JSON.stringify({
              local: { last: "/workspace/product", recent: ["/workspace/product"] },
            }),
          );
        }, theme);
        await gotoView(page, "activity");
        await page.goto("/?chat=open");
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      });

      test("should dismiss session actions outside without closing chat", async ({
        page,
      }, info) => {
        const input = page.getByTestId("chat-input").filter({ visible: true });
        await input.fill("Keep my draft while dismissing overlays");
        const actions = page.getByTestId("chat-options-button").filter({ visible: true });
        if (width < 1000) await actions.tap();
        else await actions.click();
        await expect(actions).toHaveAttribute("aria-expanded", "true");
        await page.screenshot({ path: info.outputPath(`actions-${width}-${theme}.png`) });
        if (width < 1000) {
          for (const button of [actions, page.getByTestId("chat-config-button")]) {
            const bounds = await button.boundingBox();
            expect(bounds?.height).toBeGreaterThanOrEqual(44);
            expect(bounds?.width).toBeGreaterThanOrEqual(44);
          }
        }
        if (width < 1000) await input.tap();
        else await input.click();
        await expect(actions).toHaveAttribute("aria-expanded", "false");
        await expect(input).toHaveValue("Keep my draft while dismissing overlays");
        await expect(input).toBeFocused();
        if (width < 1000) await actions.tap();
        else await actions.click();
        const messages = page.getByTestId("chat-messages").filter({ visible: true });
        if (width < 1000) await messages.tap({ position: { x: 8, y: 8 } });
        else await messages.click({ position: { x: 8, y: 8 } });
        await expect(actions).toHaveAttribute("aria-expanded", "false");
        if (width < 1000) await actions.tap();
        else await actions.click();
        await expect(page.getByTestId("chat-actions-menu")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(actions).toHaveAttribute("aria-expanded", "false");
        await expect(actions).toBeFocused();
        if (width < 1000) await actions.tap();
        else await actions.click();
        await page.getByTestId("chat-config-button").click();
        await expect(page.getByTestId("chat-config-dialog")).toBeVisible();
        await expect(page.getByTestId("chat-actions-menu")).toBeHidden();
        await page.getByTestId("chat-agent-options").locator("summary").click();
        await page.getByTestId("chat-agent-options-input").fill("{}");
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("chat-config-dialog")).toBeHidden();
        await expect(actions).toHaveAttribute("aria-expanded", "false");
        await expect(input).toHaveValue("Keep my draft while dismissing overlays");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      });

      test("should dismiss neighboring pickers with outside taps and preserve their actions", async ({
        page,
      }) => {
        const input = page.getByTestId("chat-input").filter({ visible: true });
        await input.fill("Picker draft");
        for (const [trigger, picker] of [
          ["chat-agent-model-button", "chat-agent-model-picker"],
          ["chat-workspace-folder", "chat-workspace-folder-picker"],
          ["chat-workspace-branch", "chat-workspace-branch-picker"],
        ]) {
          const button = page.getByTestId(trigger).filter({ visible: true });
          await button.scrollIntoViewIfNeeded();
          if (width < 1000) await button.tap();
          else await button.click();
          await expect(page.getByTestId(picker)).toBeVisible();
          const messages = page.getByTestId("chat-messages").filter({ visible: true });
          if (width < 1000) await messages.tap({ position: { x: 8, y: 8 } });
          else await messages.click({ position: { x: 8, y: 8 } });
          await expect(page.getByTestId(picker)).toBeHidden();
          await expect(input).toHaveValue("Picker draft");
        }
        const agent = page.getByTestId("chat-agent-model-button").filter({ visible: true });
        await agent.click();
        await page.getByTestId("chat-agent-option-claude").click();
        await expect(page.getByTestId("chat-agent-option-claude")).toHaveAttribute(
          "aria-checked",
          "true",
        );
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("chat-agent-model-picker")).toBeHidden();
        await expect(input).toHaveValue("Picker draft");
        await page.getByTestId("chat-panel").getByTestId("notification-bell").click();
        await expect(page.getByTestId("notification-menu")).toBeVisible();
        const messages = page.getByTestId("chat-messages").filter({ visible: true });
        const outside = await messages.boundingBox();
        if (!outside) throw new Error("Conversation has no visible bounds");
        // The notification center is modal; its backdrop receives this real screen tap.
        if (width < 1000) await page.touchscreen.tap(outside.x + 8, outside.y + outside.height - 8);
        else await page.mouse.click(outside.x + 8, outside.y + outside.height - 8);
        await expect(page.getByTestId("notification-menu")).toBeHidden();
        await expect(input).toHaveValue("Picker draft");
      });
    });
  }
}
