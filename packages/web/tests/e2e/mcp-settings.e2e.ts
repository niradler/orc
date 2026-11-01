import { expect, test } from "@playwright/test";
import { settingsSection } from "./_chat-ui";
import { API_SECRET, AUTH_HEADERS } from "./_helpers";

for (const width of [1440, 390]) {
  test(`MCP settings persist and edit prompts at ${width}px`, async ({
    page,
    request,
  }, testInfo) => {
    const original = await (
      await request.get("/api/settings/mcp", { headers: AUTH_HEADERS })
    ).json();
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
      await settingsSection(page, "mcp");
      const section = page.getByTestId("mcp-settings");
      await expect(section).toBeVisible();
      await expect(page.getByTestId("mcp-prompt-editor")).toHaveCount(0);
      await page.getByTestId("mcp-default-mode").selectOption("full");
      await page.getByTestId("mcp-add-prompt").click();
      const editor = page.getByTestId("mcp-prompt-editor");
      await editor.getByLabel("Prompt name", { exact: true }).fill("browser-example");
      await editor.getByLabel("Prompt title", { exact: true }).fill("Browser example");
      await editor.getByLabel("Prompt instructions").fill("Answer with current ORC data.");
      await page.getByTestId("mcp-save").click();
      await expect(section.getByRole("status")).toContainText("MCP settings saved");
      await page.reload();
      await settingsSection(page, "mcp");
      await expect(page.getByTestId("mcp-default-mode")).toHaveValue("full");
      await expect(section).toContainText("Browser example");
      await expect(page.getByTestId("mcp-prompt-editor")).toHaveCount(0);
      await section.getByText("Resources · 1").click();
      await expect(section).toContainText("orc://ui/catalog");
      expect(await section.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      await section.screenshot({ path: testInfo.outputPath(`mcp-settings-${width}.png`) });
      const saved = await (
        await request.get("/api/settings/mcp", { headers: AUTH_HEADERS })
      ).json();
      expect(
        saved.prompts.find((prompt: { name: string }) => prompt.name === "browser-example").content,
      ).toBe("Answer with current ORC data.");
      expect(errors).toEqual([]);
    } finally {
      expect(
        (await request.patch("/api/settings/mcp", { headers: AUTH_HEADERS, data: original })).ok(),
      ).toBe(true);
    }
  });
}
