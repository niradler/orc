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
      const name = `Notifications ${id} with a long review team name`;
      // Disabled fixture connections cannot contact a real messaging provider.
      const saved = await request.put(`${API_BASE}/channels/${id}`, {
        headers: AUTH_HEADERS,
        data: {
          id,
          name,
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
      const row = page.getByTestId(`channel-row-${id}`);
      await expect(row).toBeVisible();
      const edit = row.getByRole("button", { name: `Edit ${name}`, exact: true });
      const editBounds = await edit.boundingBox();
      expect(editBounds && editBounds.x >= 0 && editBounds.x + editBounds.width <= width).toBe(
        true,
      );
      expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (width === 390) {
        expect(editBounds?.width).toBeGreaterThanOrEqual(44);
        expect(editBounds?.height).toBeGreaterThanOrEqual(44);
      }
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
      await edit.click();
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
      await page.getByRole("button", { name: `Edit ${name}`, exact: true }).click();
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

for (const width of [1440, 390]) {
  test(`should reserve channel policy controls while loading and saving at ${width}px`, async ({
    page,
    request,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    let releaseLoad = () => {};
    let releaseSave = () => {};
    let saveStarted = () => {};
    const load = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const save = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const saving = new Promise<void>((resolve) => {
      saveStarted = resolve;
    });
    await page.route("**/api/channels/notification-policy", async (route) => {
      if (route.request().method() === "GET") {
        await load;
        await route.fulfill({ json: { enabled: false, base_url: "https://saved.orc.example" } });
      } else if (route.request().method() === "PUT") {
        saveStarted();
        await save;
        await route.continue();
      } else await route.continue();
    });
    try {
      await gotoView(page, "settings");
      await settingsSection(page, "channels");
      const policy = page.getByTestId("channel-notification-settings");
      await policy.locator("summary").first().click();
      const input = policy.getByTestId("notification-base-url");
      const toggle = policy.getByLabel("Enable channel notification forwarding", { exact: true });
      const submit = policy.getByTestId("notification-policy-save");
      await expect(input).toBeVisible();
      expect(await input.isDisabled()).toBe(true);
      expect(await toggle.isDisabled()).toBe(true);
      expect(await submit.isDisabled()).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("channel-policy-loading.png") });
      releaseLoad();
      await expect(input).toHaveValue("https://saved.orc.example");
      await expect(input).toBeEnabled();
      await expect(toggle).toBeEnabled();
      await input.fill("https://draft.orc.example");
      await toggle.check();
      await expect(input).toHaveValue("https://draft.orc.example");
      await page.screenshot({ path: testInfo.outputPath("channel-policy-ready.png") });
      await submit.click();
      await saving;
      expect(await input.isDisabled()).toBe(true);
      expect(await toggle.isDisabled()).toBe(true);
      expect(await submit.isDisabled()).toBe(true);
      releaseSave();
      await expect(policy.getByRole("status")).toHaveText("Notification forwarding enabled.");
      await expect(input).toBeEnabled();
      await expect(input).toHaveValue("https://draft.orc.example");
      await expect(toggle).toBeChecked();
      const stored = await apiGet<{ base_url: string }>(request, "/channels/notification-policy");
      expect(stored.base_url).toBe("https://draft.orc.example");
    } finally {
      releaseLoad();
      releaseSave();
      const restored = await request.put(`${API_BASE}/channels/notification-policy`, {
        headers: AUTH_HEADERS,
        data: { enabled: false, base_url: "" },
      });
      expect(restored.ok()).toBe(true);
    }
  });

  test(`should keep channel policy controls disabled after a failed load at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/channels/notification-policy", (route) =>
      route.fulfill({ status: 503, json: { error: "Fixture policy unavailable." } }),
    );
    await gotoView(page, "settings");
    await settingsSection(page, "channels");
    const policy = page.getByTestId("channel-notification-settings");
    await policy.locator("summary").first().click();
    await expect(policy.getByRole("alert")).toContainText("Fixture policy unavailable.");
    expect(await policy.getByTestId("notification-base-url").isDisabled()).toBe(true);
    expect(
      await policy
        .getByLabel("Enable channel notification forwarding", { exact: true })
        .isDisabled(),
    ).toBe(true);
    expect(await policy.getByTestId("notification-policy-save").isDisabled()).toBe(true);
  });
}
