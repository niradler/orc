import { ChatSettingsSchema } from "@orc/core/chat";
import { expect, test } from "@playwright/test";
import { API_SECRET, gotoView } from "./_helpers";

for (const width of [320, 1440]) {
  test(`header model dropdown discovers and selects agent models at ${width}px`, async ({
    page,
    request,
  }, testInfo) => {
    const defaults = ChatSettingsSchema.parse({ models: [{ agent: "codex", id: "saved-codex" }] });
    await request.patch("/api/settings", {
      headers: { Authorization: `Bearer ${API_SECRET}` },
      data: { chat: defaults },
    });
    const agents: string[] = [];
    await page.route("**/api/chat/models?**", (route) => {
      const agent = new URL(route.request().url()).searchParams.get("agent") ?? "";
      agents.push(agent);
      return route.fulfill({
        json:
          agent === "gemini"
            ? { models: [], warning: "Choose a saved model or enter a custom model ID." }
            : {
                models: [{ id: `${agent}-native`, label: `${agent} discovered model` }],
                warning: null,
              },
      });
    });
    await page.setViewportSize({ width, height: 900 });
    await gotoView(page, "dashboard");
    await page.goto("/?chat=open");
    const model = page.getByTestId("chat-model-select").filter({ visible: true });
    const agent = page.getByTestId("chat-agent-select").filter({ visible: true });
    await expect(model.locator("option[value='codex-native']")).toHaveCount(1);
    await expect(model.locator("option[value='saved-codex']")).toHaveCount(1);
    const agentBox = await agent.boundingBox();
    const modelBox = await model.boundingBox();
    expect(Math.abs((agentBox?.y ?? 0) - (modelBox?.y ?? 0))).toBeLessThan(2);
    expect(modelBox?.x).toBeGreaterThan(agentBox?.x ?? 0);
    await model.selectOption("codex-native");
    await expect(page.getByTestId("chat-config-dialog")).toHaveCount(0);
    await agent.selectOption("claude");
    await expect(model).toHaveValue("");
    await expect(model.locator("option[value='claude-native']")).toHaveCount(1);
    await expect(model.locator("option[value='codex-native']")).toHaveCount(0);
    await agent.selectOption("gemini");
    await expect(page.getByTestId("chat-model-warning").filter({ visible: true })).toBeVisible();
    await model.selectOption("__custom__");
    await page.getByTestId("chat-custom-model").fill("--bad");
    await page.getByTestId("chat-custom-model-apply").click();
    await expect(page.getByRole("alert")).toContainText("valid model ID");
    await page.getByTestId("chat-custom-model").fill("provider/custom-model");
    await page.getByTestId("chat-custom-model-apply").click();
    await expect(model).toHaveValue("provider/custom-model");
    await agent.selectOption("codex");
    await model.selectOption("codex-native");
    await page.screenshot({ path: testInfo.outputPath(`chat-models-${width}.png`) });
    const sent = page.waitForRequest((request) => request.url().endsWith("/api/chat/stream"));
    await page.getByTestId("chat-input").filter({ visible: true }).fill("Test selected model");
    await page.getByTestId("chat-send-button").filter({ visible: true }).click();
    expect((await sent).postDataJSON()).toMatchObject({ agent: "codex", model: "codex-native" });
    await expect(page.getByTestId("chat-input").filter({ visible: true })).toBeEnabled();
    expect(agents).toContain("claude");
    expect(agents).toContain("gemini");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
