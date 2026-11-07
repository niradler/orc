import { ChatSettingsSchema } from "@orc/core/chat";
import { expect, test } from "@playwright/test";
import { chooseChatAgent, chooseChatModel, openChatModel } from "./_chat-ui";
import { API_SECRET, gotoView } from "./_helpers";

for (const width of [320, 1440]) {
  test(`composer model picker discovers and selects agent models at ${width}px`, async ({
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
            ? { models: [], warning: null }
            : {
                models: [{ id: `${agent}-native`, label: `${agent} discovered model` }],
                warning: null,
              },
      });
    });
    await page.setViewportSize({ width, height: 900 });
    await gotoView(page, "activity");
    await page.goto("/?chat=open");
    const pill = page.getByTestId("chat-agent-model-button").filter({ visible: true });
    const pillBox = await pill.boundingBox();
    await expect(pill.getByTestId("chat-model-current")).toBeHidden();
    await expect(pill).toHaveAccessibleName(/Agent default/);
    expect(pillBox?.y).toBeGreaterThan(
      (await page.getByTestId("chat-input").boundingBox())?.y ?? 0,
    );
    await openChatModel(page);
    await expect(page.getByRole("heading", { name: "Choose model" })).toHaveCount(0);
    await expect(page.getByTestId("chat-model-option-codex-native")).toBeVisible();
    await expect(page.getByTestId("chat-model-option-saved-codex")).toBeVisible();
    await page.getByTestId("chat-model-option-codex-native").click();
    await expect(page.getByTestId("chat-model-select")).toBeHidden();
    await expect(pill).toHaveAccessibleName(/codex discovered model/);
    await chooseChatAgent(page, "claude");
    await expect(pill).toHaveAccessibleName(/Agent default/);
    await openChatModel(page);
    await expect(page.getByTestId("chat-model-option-claude-native")).toBeVisible();
    await expect(page.getByTestId("chat-model-option-codex-native")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await chooseChatAgent(page, "gemini");
    await openChatModel(page);
    await expect(page.getByTestId("chat-model-warning")).toHaveCount(0);
    await page.getByTestId("chat-model-option-custom").click();
    await page.getByTestId("chat-custom-model").fill("--bad");
    await page.getByTestId("chat-custom-model-apply").click();
    await expect(page.getByRole("alert")).toContainText("valid model ID");
    await page.getByTestId("chat-custom-model").fill("provider/custom-model");
    await page.getByTestId("chat-custom-model-apply").click();
    await expect(page.getByTestId("chat-custom-model")).toBeHidden();
    await expect(pill).toHaveAccessibleName(/provider\/custom-model/);
    await chooseChatAgent(page, "codex");
    await chooseChatModel(page, "codex-native");
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

test("choosing a custom model does not submit an existing composer draft", async ({
  page,
  request,
}) => {
  await request.patch("/api/settings", {
    headers: { Authorization: `Bearer ${API_SECRET}` },
    data: { chat: ChatSettingsSchema.parse({}) },
  });
  await page.route("**/api/chat/models?**", (route) =>
    route.fulfill({ json: { models: [], warning: null } }),
  );
  let posts = 0;
  await page.route("**/api/chat/stream", (route) => {
    posts++;
    return route.fulfill({ contentType: "text/event-stream", body: 'data: {"type":"done"}\n\n' });
  });
  await gotoView(page, "tasks");
  await page.goto("/tasks?chat=open");
  await page.getByTestId("chat-input").fill("Unsent draft while choosing a model");
  await openChatModel(page);
  await page.getByTestId("chat-model-option-custom").click();
  await page.getByTestId("chat-custom-model").fill("--invalid");
  await page.getByTestId("chat-custom-model-apply").click();
  await expect(page.getByRole("alert")).toContainText("valid model ID");
  await expect(page.getByTestId("chat-input")).toHaveValue("Unsent draft while choosing a model");
  expect(posts).toBe(0);
  await page.getByTestId("chat-custom-model").fill("fixture-custom");
  await page.getByTestId("chat-custom-model-apply").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("chat-model-current")).toHaveText("fixture-custom");
  await expect(page.getByTestId("chat-input")).toHaveValue("Unsent draft while choosing a model");
  expect(posts).toBe(0);
});
