import { ChatSettingsSchema } from "@orc/core/chat";
import { expect } from "@playwright/test";
import { API_SECRET, apiDelete, apiPost, gotoView, repoRoot, tid } from "./_helpers";
import { test } from "./_terminal-fixture";

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
        await page.getByTestId("chat-settings-tab-customize").click();
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
        // The workspace header owns the only bell, including on the chat page.
        await expect(page.locator('[data-testid="notification-bell"]:visible')).toHaveCount(1);
        await page.locator('[data-testid="notification-bell"]:visible').click();
        if (width < 768) {
          // Phones open the full notifications page; back returns to the same draft.
          await expect(page.getByTestId("notifications-page")).toBeVisible();
          await page.getByTestId("notifications-back").click();
          await expect(input).toHaveValue("Picker draft");
          return;
        }
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

for (const width of [390, 1440]) {
  test.describe(`global terminal menus at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, hasTouch: width < 1000 });

    test("should dismiss pane actions outside and keep its terminal running", async ({
      page,
      request,
    }, info) => {
      const terminal = await apiPost<{ id: string; pid: number }>(request, "/terminals", {
        kind: "shell",
        host: null,
        cwd: repoRoot(),
      });
      await gotoView(page, "terminals");
      await page.goto(`/terminals/${terminal.id}`);
      const viewport = page.getByTestId("terminal-viewport").filter({ visible: true }).first();
      await expect(viewport).toBeVisible();
      await page.getByTestId("pane-actions").filter({ visible: true }).first().click();
      await expect(page.getByTestId("terminal-options").filter({ visible: true })).toBeVisible();
      await page.screenshot({ path: info.outputPath(`pane-menu-${width}.png`) });
      if (width < 1000) await viewport.tap();
      else await viewport.click();
      await expect(page.getByTestId("pane-actions-menu")).toBeHidden();
      await expect(viewport.getByRole("textbox", { name: "Terminal input" }).last()).toBeFocused();
      const actions = page.getByTestId("pane-actions").filter({ visible: true }).first();
      await actions.click();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("pane-actions-menu")).toBeHidden();
      await expect(actions).toBeFocused();

      if (width === 1440) {
        await page.getByTestId("terminal-actions").click();
        await expect(page.getByTestId("terminal-actions-menu")).toBeVisible();
        await viewport.click();
        await expect(page.getByTestId("terminal-actions-menu")).toBeHidden();
      }
      const launcher = page.getByTestId("terminal-new").filter({ visible: true }).first();
      await launcher.click();
      await expect(page.getByTestId("terminal-launch-menu")).toBeVisible();
      const folder = await page.getByTestId("terminal-cwd").inputValue();
      const bounds = await viewport.boundingBox();
      if (!bounds) throw new Error("Terminal has no visible bounds");
      if (width < 1000) await page.touchscreen.tap(bounds.x + 8, bounds.y + bounds.height - 8);
      else await viewport.click();
      await expect(page.getByTestId("terminal-launch-menu")).toBeHidden();
      await launcher.click();
      await expect(page.getByTestId("terminal-cwd")).toHaveValue(folder);
      await page.keyboard.press("Escape");
      await expect(launcher).toBeFocused();

      await page.getByTestId("pane-view-git").click();
      const taskLink = page.getByTestId("terminal-task-link-toggle");
      await taskLink.click();
      await expect(page.getByTestId("terminal-task-link-menu")).toBeVisible();
      await page.getByTestId("git-link-task").focus();
      await expect(page.getByTestId("terminal-task-link-menu")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("terminal-task-link-menu")).toBeHidden();
      await expect(taskLink).toBeFocused();
      await taskLink.click();
      await page.getByTestId("git-refresh").click();
      await expect(page.getByTestId("terminal-task-link-menu")).toBeHidden();
      const state = await request.get(`/api/terminals/${terminal.id}`, {
        headers: { Authorization: `Bearer ${API_SECRET}` },
      });
      expect(state.ok()).toBe(true);
      expect((await state.json()).pid).toBe(terminal.pid);
    });

    test("should dismiss project and document menus without losing their containing workspace", async ({
      page,
      request,
    }) => {
      await gotoView(page, "activity");
      const drawer = page.getByTestId("mobile-nav-drawer");
      if (width < 1000) await page.getByTestId("mobile-nav-open").tap();
      const picker =
        width < 1000
          ? drawer.getByTestId("sidebar-project-select")
          : page.getByTestId("sidebar-project-select").filter({ visible: true });
      await picker.click();
      await expect(page.getByTestId("project-picker-menu")).toBeVisible();
      await page.getByTestId("project-picker-search").fill("All");
      if (width < 1000) await page.touchscreen.tap(width - 4, 860);
      else await page.mouse.click(width - 4, 860);
      await expect(page.getByTestId("project-picker-menu")).toBeHidden();
      if (width < 1000) {
        await expect(drawer).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(drawer).toBeHidden();
      }
      const kb = await apiPost<{ id: string }>(request, "/kb/bases", {
        name: tid("overlay-demo"),
        project_id: null,
      });
      try {
        const doc = await apiPost<{ id: string }>(request, `/kb/bases/${kb.id}/documents`, {
          title: "Overlay menu demo",
          content: "Keep this document while dismissing its menu.",
        });
        await page.goto(`/knowledge/base?kb=${kb.id}&document=${doc.id}`);
        const document = page
          .getByTestId("kb-document")
          .getByTestId("markdown-preview")
          .filter({ visible: true });
        await expect(document).toContainText("Keep this document");
        const menu = page.getByTestId("kb-doc-menu");
        await menu.click();
        await expect(page.getByTestId("kb-doc-actions-menu")).toBeVisible();
        if (width < 1000) await document.tap();
        else await document.click();
        await expect(page.getByTestId("kb-doc-actions-menu")).toBeHidden();
        await expect(document).toContainText("Keep this document");
        await menu.click();
        await page.keyboard.press("Escape");
        await expect(menu).toBeFocused();
      } finally {
        await apiDelete(request, `/kb/bases/${kb.id}`);
      }
    });
  });
}
