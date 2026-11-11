import { expect, test } from "@playwright/test";
import { settingsSection } from "./_chat-ui";
import { API_BASE, API_SECRET, AUTH_HEADERS } from "./_helpers";

for (const width of [390, 1440]) {
  test(`Pi provider preserves native options and exposes help at ${width}px`, async ({
    page,
    request,
  }, info) => {
    const initial = await (
      await request.get(`${API_BASE}/settings/providers`, { headers: AUTH_HEADERS })
    ).json();
    await page.addInitScript(
      (secret) =>
        localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
      API_SECRET,
    );
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/chat/models?**", (route) =>
      route.fulfill({
        json: { models: [{ id: "fixture/model", label: "Fixture model" }], warning: null },
      }),
    );
    try {
      await page.goto("/settings");
      await settingsSection(page, "agents");
      await page.getByTestId("provider-new").click();
      await page.getByTestId("provider-new-name").fill("Pi fixture");
      await page.getByTestId("provider-new-adapter").selectOption("pi");
      await page.getByTestId("provider-create").click();
      await page.getByTestId("provider-model").fill("fixture/model");
      await page.getByTestId("provider-advanced").locator("summary").click();
      const options = { thinkingLevel: "high", autoCompaction: true, autoRetry: false };
      await page.getByTestId("provider-options").fill(JSON.stringify(options));
      const help = page.getByTestId("provider-options-help");
      if (width === 1440) {
        await help.hover();
        await expect(page.getByTestId("provider-options-help-content")).toContainText(
          "thinkingLevel",
        );
        await page.mouse.move(0, 0);
      }
      await help.focus();
      await expect(page.getByTestId("provider-options-help-content")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("provider-options-help-content")).toHaveCount(0);
      await help.click();
      await expect(page.getByTestId("provider-options-help-content")).toContainText("Pi options");
      await page.keyboard.press("Escape");
      await page.getByTestId("agent-settings-save").click();
      await expect(page.getByTestId("agent-settings-saved")).toBeVisible();
      const saved = await (
        await request.get(`${API_BASE}/settings/providers`, { headers: AUTH_HEADERS })
      ).json();
      const pi = saved.providers.find((profile: { name: string }) => profile.name === "Pi fixture");
      expect(pi.options).toEqual({ runtime: "pi", options });
      await page.reload();
      await settingsSection(page, "agents");
      await page.getByTestId(`provider-select-${pi.id}`).click();
      await page.getByTestId("provider-advanced").locator("summary").click();
      await expect(page.getByTestId("provider-options")).toHaveValue(
        JSON.stringify(options, null, 2),
      );
      await expect(page.getByTestId("provider-model")).toHaveValue("fixture/model");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.getByTestId("provider-options").scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`pi-provider-${width}.png`) });
    } finally {
      const current = await (
        await request.get(`${API_BASE}/settings/providers`, { headers: AUTH_HEADERS })
      ).json();
      expect(
        (
          await request.put(`${API_BASE}/settings/providers`, {
            headers: AUTH_HEADERS,
            data: { ...initial, revision: current.revision },
          })
        ).ok(),
      ).toBe(true);
    }
  });
}
