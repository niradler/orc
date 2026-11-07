import { expect, test } from "@playwright/test";
import { settingsSection } from "./_chat-ui";
import { API_BASE, AUTH_HEADERS, apiGet, apiPatch, gotoView, tid } from "./_helpers";

for (const width of [1440, 390])
  for (const theme of ["dark", "light"] as const) {
    test(`channel notification opt-in, preview and save/reopen ${theme} ${width}`, async ({
      page,
      request,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await apiPatch(request, "/settings", { theme });
      const id = tid("notify-channel");
      // Disabled fixture connections cannot contact a real messaging provider.
      const saved = await request.put(`${API_BASE}/channels/${id}`, {
        headers: AUTH_HEADERS,
        data: {
          id,
          name: `Notifications ${id}`,
          provider: "telegram",
          enabled: false,
          targets: [{ id: "me", name: "Notification recipient", chat_id: "123", outbound: true }],
          routes: [],
          credentials: {},
        },
      });
      expect(saved.ok()).toBe(true);
      await gotoView(page, "settings");
      await settingsSection(page, "channels");
      const global = page.getByTestId("channel-notification-settings");
      await expect(global).not.toHaveAttribute("open", "");
      await global.locator("summary").first().click();
      await global.getByTestId("notification-base-url").fill("https://orc.example");
      await global.getByLabel("Enable channel notification forwarding", { exact: true }).check();
      await global.getByTestId("notification-policy-save").click();
      await expect(global.getByRole("status")).toHaveText("Notification forwarding enabled.");
      await expect(
        global.locator("summary").filter({ hasText: /Recent deliveries/ }),
      ).toBeVisible();
      await page.getByRole("button", { name: `Edit Notifications ${id}`, exact: true }).click();
      const editor = page.getByTestId("channel-editor").filter({ visible: true });
      await editor
        .locator("summary")
        .filter({ hasText: /^Recipients/ })
        .click();
      await editor.getByRole("button", { name: "Edit me", exact: true }).click();
      const filters = editor.getByTestId("channel-notification-filters");
      await expect(filters.getByLabel("Forward notifications", { exact: true })).not.toBeChecked();
      await filters.getByLabel("Forward notifications", { exact: true }).check();
      await filters.locator("summary").click();
      await filters
        .getByRole("group", { name: "Outcome", exact: true })
        .getByLabel("failure", { exact: true })
        .check();
      await filters.getByTestId("notification-filter-preview").click();
      await expect(filters.getByTestId("notification-preview-result")).toContainText(
        "Matches draft filters",
      );
      await filters.getByTestId("notification-preview-type").selectOption("job.finished");
      await filters.getByTestId("notification-filter-preview").click();
      await expect(filters.getByTestId("notification-preview-result")).toContainText(
        "Does not match draft filters",
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const saveBounds = await editor.getByTestId("channel-target-apply").boundingBox();
      expect(saveBounds && saveBounds.width > 0 && saveBounds.x + saveBounds.width <= width).toBe(
        true,
      );
      await page.screenshot({
        path: `../../.claude/docs/channel-notifications-${theme}-${width}.png`,
        fullPage: true,
        animations: "disabled",
      });
      await editor.getByTestId("channel-target-apply").click();
      await editor.getByTestId("channel-save").click();
      await expect(page.getByRole("status").filter({ hasText: "Connection saved" })).toBeVisible();
      await page.reload();
      await settingsSection(page, "channels");
      await page.getByRole("button", { name: `Edit Notifications ${id}`, exact: true }).click();
      const reopened = page.getByTestId("channel-editor").filter({ visible: true });
      await reopened
        .locator("summary")
        .filter({ hasText: /^Recipients/ })
        .click();
      await reopened.getByRole("button", { name: "Edit me", exact: true }).click();
      const restored = reopened.getByTestId("channel-notification-filters");
      await expect(restored.getByLabel("Forward notifications", { exact: true })).toBeChecked();
      await restored.locator("summary").click();
      await expect(
        restored
          .getByRole("group", { name: "Outcome", exact: true })
          .getByLabel("failure", { exact: true }),
      ).toBeChecked();
      const policy = page.getByTestId("channel-notification-settings");
      await policy.locator("summary").first().click();
      await expect(policy.getByTestId("notification-base-url")).toHaveValue("https://orc.example");
      await policy.getByLabel("Enable channel notification forwarding", { exact: true }).uncheck();
      await policy.getByTestId("notification-policy-save").click();
      await expect(policy.getByRole("status")).toHaveText("Notification forwarding paused.");
      expect(
        (await apiGet<{ enabled: boolean }>(request, "/channels/notification-policy")).enabled,
      ).toBe(false);
    });
  }
