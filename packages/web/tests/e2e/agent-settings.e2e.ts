import { expect, test } from "@playwright/test";
import { settingsSection } from "./_chat-ui";
import { API_SECRET, apiPatch, gotoView } from "./_helpers";

for (const width of [1440, 390]) {
  test(`enabled coding agents drive the chat agent picker at ${width}px`, async ({
    page,
    request,
  }, testInfo) => {
    await apiPatch(request, "/settings", { agents: [] });
    await page.addInitScript(
      (secret) =>
        localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
      API_SECRET,
    );
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/settings");
      await settingsSection(page, "agents");
      await expect(page.getByTestId("agent-enabled-copilot")).toBeChecked();
      await expect(page.getByTestId("agent-enabled-opencode")).not.toBeChecked();
      await expect(page.getByTestId("agent-settings-save")).toBeDisabled();
      await page.getByTestId("agent-enabled-copilot").uncheck();
      await page.getByTestId("agent-enabled-opencode").check();
      await page.getByTestId("agent-custom").fill("qoder");
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.getByTestId("agent-enabled-qoder")).toBeChecked();
      await page.getByTestId("agent-settings-save").click();
      await expect(page.getByTestId("agent-settings-saved")).toBeVisible();
      const section = page.getByRole("region", { name: "Coding agents" });
      expect(await section.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      await section.screenshot({ path: testInfo.outputPath(`agent-settings-${width}.png`) });

      await page.reload();
      await settingsSection(page, "agents");
      await expect(page.getByTestId("agent-enabled-opencode")).toBeChecked();
      await expect(page.getByTestId("agent-enabled-copilot")).not.toBeChecked();

      await gotoView(page, "tasks");
      await page.goto("/tasks?chat=full");
      await page.getByTestId("chat-agent-button").filter({ visible: true }).click();
      await expect(page.getByTestId("chat-agent-option-opencode")).toHaveText("OpenCode");
      await expect(page.getByTestId("chat-agent-option-qoder")).toHaveText("qoder");
      await expect(page.getByTestId("chat-agent-option-copilot")).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`chat-agent-picker-${width}.png`) });
      expect(errors).toEqual([]);
    } finally {
      await apiPatch(request, "/settings", { agents: [] });
    }
  });
}
