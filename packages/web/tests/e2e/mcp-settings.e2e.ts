import { expect, test } from "@playwright/test";
import { settingsSection } from "./_chat-ui";
import { API_SECRET, AUTH_HEADERS, gotoView } from "./_helpers";

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
      await expect(section).not.toContainText("Resources");
      await expect(section).toContainText("{{request}}");
      expect(await section.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      await section.screenshot({ path: testInfo.outputPath(`mcp-settings-${width}.png`) });
      const saved = await (
        await request.get("/api/settings/mcp", { headers: AUTH_HEADERS })
      ).json();
      expect(
        saved.prompts.find((prompt: { name: string }) => prompt.name === "browser-example").content,
      ).toBe("Answer with current ORC data.");
      await gotoView(page, "tasks");
      await page.getByTestId("chat-open-button").click();
      const input = page
        .getByTestId("chat-panel")
        .filter({ visible: true })
        .getByTestId("chat-input");
      await input.fill("/browser");
      const menu = page.getByTestId("chat-prompt-menu");
      const options = menu.getByTestId("chat-prompt-option");
      await expect(options.and(page.locator('[data-kind="prompt"]'))).toHaveCount(1);
      await expect(options.first()).toContainText("Browser example");
      await input.press("Enter");
      await expect(input).toHaveValue("/browser-example ");
      await expect(menu).toHaveCount(0);
      await input.fill("fix it /orc-sd");
      await expect(options.first()).toContainText("/orc-sdlc");
      await expect(options.first()).toHaveAttribute("data-kind", "skill");
      await input.press("Enter");
      await expect(input).toHaveValue("fix it /orc-sdlc ");
      await input.pressSequentially("/orc-plat");
      await input.press("Tab");
      await expect(input).toHaveValue("fix it /orc-sdlc /orc-platform ");
      await expect(menu).toHaveCount(0);
      const commands = page.getByTestId("chat-input-command").filter({ visible: true });
      await expect(commands).toHaveText(["/orc-sdlc", "/orc-platform"]);
      const [typed, shown] = await Promise.all([
        input.boundingBox(),
        commands.first().boundingBox(),
      ]);
      expect(Math.abs((typed?.y ?? 0) - (shown?.y ?? 0))).toBeLessThan(20);
      await input.screenshot({ path: testInfo.outputPath(`chat-command-highlight-${width}.png`) });
      await input.fill("/");
      await expect(menu).toContainText("/render-ui");
      await expect(menu.locator('[data-kind="skill"]').first()).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`chat-prompt-menu-${width}.png`) });
      await page
        .getByTestId("chat-messages")
        .filter({ visible: true })
        .click({ position: { x: 8, y: 8 } });
      await expect(menu).toHaveCount(0);
      await expect(input).toHaveValue("/");
      await input.fill("/browser");
      await expect(options.first()).toContainText("Browser example");
      await options.first().click();
      await expect(input).toHaveValue("/browser-example ");
      await input.fill("/");
      await expect(menu).toBeVisible();
      await input.press("Escape");
      await expect(menu).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      expect(
        (await request.patch("/api/settings/mcp", { headers: AUTH_HEADERS, data: original })).ok(),
      ).toBe(true);
    }
  });
}
