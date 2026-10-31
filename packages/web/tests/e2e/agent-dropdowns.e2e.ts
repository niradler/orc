import { ChatSettingsSchema } from "@orc/core/chat";
import { expect, test } from "@playwright/test";
import { chooseChatAgent, openChatModel } from "./_chat-ui";
import { apiPatch, gotoView } from "./_helpers";

for (const theme of ["dark", "light"] as const) {
  for (const width of [1440, 390]) {
    test(`agent dropdown and native options are readable in ${theme} at ${width}px`, async ({
      page,
      request,
    }, testInfo) => {
      await apiPatch(request, "/settings", { theme, chat: ChatSettingsSchema.parse({}) });
      await page.setViewportSize({ width, height: 900 });
      await gotoView(page, "tasks");
      await page.goto("/tasks?chat=full");
      const picker = page.getByTestId("chat-agent-button");
      await expect(picker).toHaveText("codex");
      await picker.click();
      const list = page.getByTestId("chat-agent-select");
      await expect(list).toBeVisible();
      await expect(page.getByRole("heading", { name: "Choose agent" })).toHaveCount(0);
      await expect(page.getByTestId("chat-agent-option-cursor")).toBeVisible();
      if (width < 768)
        expect(
          (await page.getByTestId("chat-agent-option-cursor").boundingBox())?.height,
        ).toBeGreaterThanOrEqual(44);
      const colours = await list.evaluate((element) => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, text: style.color };
      });
      expect(colours).toEqual(
        theme === "dark"
          ? { background: "rgb(28, 28, 28)", text: "rgb(229, 229, 229)" }
          : { background: "rgb(243, 243, 245)", text: "rgb(37, 38, 42)" },
      );
      const bounds = await list.boundingBox();
      expect(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`agents-${theme}-${width}.png`) });
      await page.keyboard.press("Escape");
      await chooseChatAgent(page, "cursor");
      await expect(picker).toHaveText("cursor");
      await openChatModel(page);
      const option = page.getByTestId("chat-model-select").locator("option").first();
      expect(
        await option.evaluate((element) => ({
          background: getComputedStyle(element).backgroundColor,
          text: getComputedStyle(element).color,
        })),
      ).toEqual(colours);
      await page.keyboard.press("Escape");
      await page.reload();
      await expect(page.getByTestId("chat-agent-button")).toHaveText("cursor");
    });
  }
}
