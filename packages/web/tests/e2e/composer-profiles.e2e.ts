import { ChatSettingsSchema } from "@orc/core/chat";
import { type APIRequestContext, expect, test } from "@playwright/test";
import { chooseChatAgent, openChatAgentModel, showPickerTab } from "./_chat-ui";
import { AUTH_HEADERS, gotoView } from "./_helpers";

const models = {
  models: [
    { id: "opus", label: "Opus", efforts: ["low", "high", "max"] },
    { id: "sonnet", label: "Sonnet", efforts: ["low", "high"] },
    { id: "haiku", label: "Haiku" },
  ],
  warning: null,
};

async function saveComposer(request: APIRequestContext, data: Record<string, unknown>) {
  const current = await (await request.get("/api/settings", { headers: AUTH_HEADERS })).json();
  const response = await request.patch("/api/settings", {
    headers: AUTH_HEADERS,
    data: { ...data, composer_revision: current.composer_revision },
  });
  expect(response.status()).toBe(200);
}

test.beforeEach(async ({ page, request }) => {
  await saveComposer(request, {
    chat: ChatSettingsSchema.parse({ agent: "claude", permissionMode: "plan" }),
    favorite_models: [],
    composer_profiles: [],
  });
  await page.route("**/api/chat/models?**", (route) => route.fulfill({ json: models }));
});
test.afterEach(async ({ request }) => {
  await saveComposer(request, {
    chat: ChatSettingsSchema.parse({}),
    favorite_models: [],
    composer_profiles: [],
  });
});

for (const width of [1440, 390]) {
  test(`favorites pin to the top, the gear opens provider settings and a profile restores all four choices at ${width}px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await gotoView(page, "activity");
    await page.goto("/?chat=open");
    await chooseChatAgent(page, "claude");
    await openChatAgentModel(page);
    await showPickerTab(page, "model");
    const rows = page.getByTestId("chat-model-select").locator('[role="menuitemradio"]');
    await expect(rows.first()).toHaveAttribute("data-testid", "chat-model-option-default");
    await page.getByTestId("chat-model-favorite-haiku").click();
    await page.getByTestId("chat-model-favorite-sonnet").click();
    await expect(page.getByTestId("chat-model-favorite-sonnet")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(rows.nth(0)).toHaveAttribute("data-testid", "chat-model-option-sonnet");
    await expect(rows.nth(1)).toHaveAttribute("data-testid", "chat-model-option-haiku");
    await expect
      .poll(
        async () =>
          (await (await request.get("/api/settings", { headers: AUTH_HEADERS })).json())
            .favorite_models,
      )
      .toEqual([
        { agent: "claude", id: "haiku" },
        { agent: "claude", id: "sonnet" },
      ]);
    await page.getByTestId("chat-model-favorite-haiku").click();
    await expect(rows.nth(1)).not.toHaveAttribute("data-testid", "chat-model-option-haiku");

    await page.getByTestId("chat-model-option-opus").click();
    await openChatAgentModel(page);
    await showPickerTab(page, "effort");
    await page.getByTestId("chat-effort-option-max").click();
    await openChatAgentModel(page);
    await page.getByTestId("chat-profile-new").click();
    await page.getByTestId("chat-profile-name").fill("Deep plan");
    await page.getByTestId("chat-profile-save").click();
    await expect(page.getByTestId("chat-profiles")).toContainText("Deep plan");
    await expect
      .poll(
        async () =>
          (await (await request.get("/api/settings", { headers: AUTH_HEADERS })).json())
            .composer_profiles,
      )
      .toMatchObject([
        {
          name: "Deep plan",
          agent: "claude",
          model: "opus",
          effort: "max",
          permissionMode: "plan",
        },
      ]);

    await page.keyboard.press("Escape");
    await chooseChatAgent(page, "codex");
    await openChatAgentModel(page);
    await page.getByRole("button", { name: "Deep plan", exact: true }).click();
    await expect(
      page.getByTestId("chat-agent-model-button").filter({ visible: true }),
    ).toHaveAccessibleName("Agent and model: Claude Code, Opus, Max effort");
    await expect(page.getByTestId("chat-permission-chip")).toHaveAttribute("data-mode", "plan");

    await openChatAgentModel(page);
    await showPickerTab(page, "agent");
    await page.getByTestId("chat-provider-settings-claude").click();
    await expect(page).toHaveURL(/settingsSection=agents.*provider=claude/);
    await expect(page.getByTestId("provider-name")).toHaveValue("Claude Code");
  });
}

test("a save from a stale tab is refused and retried, never dropping the other tab's change", async ({
  browser,
  request,
}) => {
  const open = async () => {
    const page = await browser.newPage();
    await page.route("**/api/chat/models?**", (route) => route.fulfill({ json: models }));
    await gotoView(page, "activity");
    await page.goto("/?chat=open");
    await chooseChatAgent(page, "claude");
    await openChatAgentModel(page);
    await showPickerTab(page, "model");
    return page;
  };
  const first = await open();
  const second = await open();
  await first.getByTestId("chat-profile-new").click();
  await first.getByTestId("chat-profile-name").fill("From first tab");
  await first.getByTestId("chat-profile-save").click();
  await expect(first.getByTestId("chat-profiles")).toContainText("From first tab");
  await second.getByTestId("chat-model-favorite-sonnet").click();
  await expect(second.getByTestId("chat-profiles").getByRole("alert")).toContainText(
    "changed elsewhere",
  );
  await expect(second.getByTestId("chat-profiles")).toContainText("From first tab");
  await second.getByTestId("chat-model-favorite-sonnet").click();
  await expect(second.getByTestId("chat-model-favorite-sonnet")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const saved = await (await request.get("/api/settings", { headers: AUTH_HEADERS })).json();
  expect(saved.favorite_models).toEqual([{ agent: "claude", id: "sonnet" }]);
  expect(saved.composer_profiles.map((item: { name: string }) => item.name)).toEqual([
    "From first tab",
  ]);
  await first.close();
  await second.close();
});

test("Codex lists its own approval presets by name", async ({ page, request }) => {
  await request.patch("/api/settings", {
    headers: AUTH_HEADERS,
    data: { chat: ChatSettingsSchema.parse({ agent: "codex" }) },
  });
  await gotoView(page, "activity");
  const response = await page.request.get("/api/chat/capabilities?agent=codex", {
    headers: AUTH_HEADERS,
  });
  expect((await response.json()).capabilities.permissionLabels).toMatchObject({
    default: { label: "Read only" },
    acceptEdits: { label: "Auto" },
    bypassPermissions: { label: "Full access" },
  });
  await page.goto("/settings?settingsSection=agents&agentsTab=chat");
  const select = page.getByTestId("chat-permission-mode");
  await expect(select.locator("option")).toHaveText(["Read only", "Plan", "Auto", "Full access"]);
});

test("a terminal launches with the chosen model, effort and mode, and a profile in one click", async ({
  page,
  request,
}) => {
  await saveComposer(request, {
    composer_profiles: [
      {
        id: "deep",
        name: "Deep plan",
        agent: "claude",
        model: "opus",
        effort: "max",
        permissionMode: "plan",
      },
    ],
  });
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/terminals", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ status: 400, json: { error: "captured", code: "VALIDATION_ERROR" } });
  });
  await page.route("**/api/terminals?**", (route) =>
    route.fulfill({
      json: {
        enabled: true,
        terminals: [],
        ready: true,
        reason: null,
        launchers: ["shell", "claude", "codex", "opencode"],
        host: null,
      },
    }),
  );
  await gotoView(page, "terminals");
  await page.getByTestId("terminal-new").filter({ visible: true }).first().click();
  const menu = page.getByTestId("terminal-launch-menu");
  await menu.getByTestId("terminal-cwd").fill(process.cwd());
  await menu.getByTestId("terminal-options-opencode").click();
  await expect(menu.getByTestId("terminal-option-effort")).toHaveCount(0);
  await expect(menu.getByTestId("terminal-option-mode").locator("option")).toHaveText([
    "Agent default",
    "Plan",
  ]);
  await menu.getByTestId("terminal-options-claude").click();
  await menu.getByTestId("terminal-option-model").selectOption("opus");
  await menu.getByTestId("terminal-option-effort").selectOption("high");
  await menu.getByTestId("terminal-option-mode").selectOption("acceptEdits");
  await menu.getByTestId("terminal-option-launch").click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toMatchObject({
    kind: "claude",
    model: "opus",
    effort: "high",
    permissionMode: "acceptEdits",
  });
  await menu.getByTestId("terminal-profile-deep").click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]).toMatchObject({
    kind: "claude",
    name: "Deep plan",
    model: "opus",
    effort: "max",
    permissionMode: "plan",
  });
});
