import { ChatSettingsSchema } from "@orc/core/chat";
import { expect, test } from "@playwright/test";
import {
  chooseChatAgent,
  chooseChatEffort,
  chooseChatModel,
  openChatModel,
  showPickerTab,
} from "./_chat-ui";
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
    await expect(page.getByTestId("chat-effort-select")).toHaveCount(0);
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
    await chooseChatEffort(page, "high");
    await expect(pill).toHaveAccessibleName(/High effort/);
    await page.keyboard.press("Escape");
    await page.screenshot({ path: testInfo.outputPath(`chat-models-${width}.png`) });
    const sent = page.waitForRequest((request) => request.url().endsWith("/api/chat/stream"));
    await page.getByTestId("chat-input").filter({ visible: true }).fill("Test selected model");
    await page.getByTestId("chat-send-button").filter({ visible: true }).click();
    expect((await sent).postDataJSON()).toMatchObject({
      agent: "codex",
      model: "codex-native",
      agentOptions: { codex: { runtime: "codex", args: ["-c", 'model_reasoning_effort="high"'] } },
    });
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
  await expect(page.getByTestId("chat-model-current")).toHaveText("Fixture Custom");
  await expect(page.getByTestId("chat-input")).toHaveValue("Unsent draft while choosing a model");
  expect(posts).toBe(0);
});

for (const width of [390, 1440]) {
  test(`model picker shows descriptions, searches and narrows efforts at ${width}px`, async ({
    page,
    request,
  }) => {
    await request.patch("/api/settings", {
      headers: { Authorization: `Bearer ${API_SECRET}` },
      data: { chat: ChatSettingsSchema.parse({ agent: "codex" }) },
    });
    const models = ["sol", "terra", "astra", "luna", "nova", "vega", "orion"].map((name) => ({
      id: `gpt-${name}`,
      label: `GPT ${name}`,
      description: `${name} model description`,
      efforts: name === "luna" ? ["low", "medium", "high"] : ["low", "medium", "high", "xhigh"],
    }));
    await page.route("**/api/chat/models?**", (route) =>
      route.fulfill({ json: { models, warning: null } }),
    );
    await page.setViewportSize({ width, height: 900 });
    await gotoView(page, "activity");
    await page.goto("/?chat=open");
    await openChatModel(page);
    await expect(page.getByTestId("chat-model-option-gpt-sol")).toContainText(
      "sol model description",
    );
    await page.getByTestId("chat-model-option-gpt-sol").click();
    await chooseChatEffort(page, "xhigh");
    await openChatModel(page);
    await page.getByTestId("chat-model-search").fill("zzz");
    await expect(page.getByTestId("chat-model-select")).toContainText("No models match");
    await page.getByTestId("chat-model-search").fill("luna");
    await expect(page.getByTestId("chat-model-option-gpt-luna")).toBeVisible();
    await expect(page.getByTestId("chat-model-option-gpt-sol")).toHaveCount(0);
    await page.getByTestId("chat-model-search").press("Enter");
    await expect(page.getByTestId("chat-model-select")).toBeHidden();
    await openChatModel(page);
    await expect(page.getByTestId("chat-effort-option-default")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.getByTestId("chat-model-search")).toHaveValue("");
    await expect(page.getByTestId("chat-model-option-gpt-luna")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await showPickerTab(page, "effort");
    await expect(page.getByTestId("chat-effort-option-high")).toBeVisible();
    await expect(page.getByTestId("chat-effort-option-xhigh")).toHaveCount(0);
    await expect(page.getByTestId("chat-effort-option-minimal")).toHaveCount(0);
    const picker = await page.getByTestId("chat-agent-model-picker").boundingBox();
    expect(picker && picker.x >= 0 && picker.x + picker.width <= width).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

test("phone picker uses Agent, Model and Effort tabs that advance on each pick", async ({
  page,
  request,
}) => {
  await request.patch("/api/settings", {
    headers: { Authorization: `Bearer ${API_SECRET}` },
    data: { chat: ChatSettingsSchema.parse({ agent: "codex" }) },
  });
  const models = ["sol", "terra", "astra", "luna", "nova", "vega", "mini"].map((name) => ({
    id: `gpt-${name}`,
    label: `GPT ${name}`,
    ...(name === "mini" ? {} : { efforts: ["low", "medium", "high"] }),
  }));
  await page.route("**/api/chat/models?**", (route) =>
    route.fulfill({ json: { models, warning: null } }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoView(page, "activity");
  await page.goto("/?chat=open");
  await page.getByTestId("chat-agent-model-button").filter({ visible: true }).click();
  const tab = (name: string) => page.getByTestId(`chat-picker-tab-${name}`);
  await expect(tab("model")).toHaveAttribute("aria-selected", "true");
  await expect(tab("model")).toHaveText("Agent default");
  await expect(page.getByTestId("chat-agent-select")).toBeHidden();
  expect((await tab("agent").boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await tab("agent").click();
  await page.getByTestId("chat-agent-option-codex").click();
  await expect(tab("model")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("chat-model-search").fill("sol");
  await page.getByTestId("chat-model-option-gpt-sol").click();
  await expect(tab("effort")).toHaveAttribute("aria-selected", "true");
  await expect(tab("model")).toHaveText("GPT sol");
  await page.getByTestId("chat-effort-option-high").click();
  await expect(page.getByTestId("chat-agent-model-picker")).toBeHidden();
  await page.getByTestId("chat-agent-model-button").filter({ visible: true }).click();
  await expect(tab("effort")).toHaveText("High");
  await page.getByTestId("chat-model-option-gpt-mini").click();
  await expect(page.getByTestId("chat-agent-model-picker")).toBeHidden();
  await page.getByTestId("chat-agent-model-button").filter({ visible: true }).click();
  await expect(tab("model")).toHaveText("GPT mini");
  await expect(tab("effort")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("a saved effort the selected model does not report is neither shown nor sent", async ({
  page,
  request,
}) => {
  await request.patch("/api/settings", {
    headers: { Authorization: `Bearer ${API_SECRET}` },
    data: {
      chat: ChatSettingsSchema.parse({
        agent: "claude",
        model: "haiku",
        agentOptions: { claude: { runtime: "claude-sdk", options: { effort: "high" } } },
      }),
    },
  });
  await page.route("**/api/chat/models?**", (route) =>
    route.fulfill({
      json: {
        models: [
          { id: "sonnet", label: "Sonnet", efforts: ["low", "medium", "high"] },
          { id: "haiku", label: "Haiku" },
        ],
        warning: null,
      },
    }),
  );
  await gotoView(page, "activity");
  await page.goto("/?chat=open");
  const pill = page.getByTestId("chat-agent-model-button").filter({ visible: true });
  await expect(pill).toHaveAccessibleName(/Haiku/);
  await expect(pill).not.toHaveAccessibleName(/effort/);
  await openChatModel(page);
  await expect(page.getByTestId("chat-effort-select")).toHaveCount(0);
  await page.keyboard.press("Escape");
  const sent = page.waitForRequest((request) => request.url().endsWith("/api/chat/stream"));
  await page.getByTestId("chat-input").filter({ visible: true }).fill("Stale effort");
  await page.getByTestId("chat-send-button").filter({ visible: true }).click();
  const body = (await sent).postDataJSON();
  expect(body.model).toBe("haiku");
  expect(body.agentOptions?.claude?.options?.effort).toBeUndefined();
});

test("a failed catalog keeps the full effort list and explains the failure", async ({
  page,
  request,
}) => {
  await request.patch("/api/settings", {
    headers: { Authorization: `Bearer ${API_SECRET}` },
    data: { chat: ChatSettingsSchema.parse({ agent: "claude", model: "haiku" }) },
  });
  await page.route("**/api/chat/models?**", (route) =>
    route.fulfill({ status: 500, json: { error: "boom" } }),
  );
  await gotoView(page, "activity");
  await page.goto("/?chat=open");
  await openChatModel(page);
  await expect(page.getByTestId("chat-model-warning")).toContainText("Models could not be loaded");
  await showPickerTab(page, "effort");
  for (const value of ["low", "medium", "high", "xhigh", "max"])
    await expect(page.getByTestId(`chat-effort-option-${value}`)).toBeVisible();
});

test("a selected model missing from the catalog keeps the full effort list", async ({
  page,
  request,
}) => {
  await request.patch("/api/settings", {
    headers: { Authorization: `Bearer ${API_SECRET}` },
    data: { chat: ChatSettingsSchema.parse({ agent: "claude", model: "custom-claude" }) },
  });
  await page.route("**/api/chat/models?**", (route) =>
    route.fulfill({ json: { models: [{ id: "haiku", label: "Haiku" }], warning: null } }),
  );
  await gotoView(page, "activity");
  await page.goto("/?chat=open");
  await openChatModel(page);
  await expect(page.getByTestId("chat-model-option-custom-claude")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  for (const value of ["low", "medium", "high", "xhigh", "max"])
    await expect(page.getByTestId(`chat-effort-option-${value}`)).toBeVisible();
});
