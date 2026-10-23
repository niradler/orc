import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ChatSettingsSchema } from "@orc/core/chat";
import { expect, test } from "@playwright/test";
import { API_SECRET } from "./_helpers";

const headers = { Authorization: `Bearer ${API_SECRET}` };
const defaults = ChatSettingsSchema.parse({});
const artifacts = resolve(process.cwd(), "../../.claude/validation/chat");
mkdirSync(artifacts, { recursive: true });
test.beforeEach(async ({ page, request }) => {
  await page.route("**/api/chat/models?**", (route) =>
    route.fulfill({ json: { models: [], warning: null } }),
  );
  await request.patch("/api/settings", { headers, data: { chat: defaults } });
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
});
test.afterEach(async ({ request }) => {
  await request.patch("/api/settings", { headers, data: { chat: defaults } });
});
async function openChat(page: import("@playwright/test").Page) {
  await page.goto("/?chat=open");
  await expect(page.getByTestId("chat-input")).toBeEnabled();
}
for (const width of [320, 820, 1440]) {
  test(`chat model, saved history and configuration work at ${width}px`, async ({
    page,
    request,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const prompt = `Operator configuration ${width}`;
    await request.patch("/api/settings", {
      headers,
      data: {
        chat: {
          ...defaults,
          system: prompt,
          model: "fixture-default",
          models: [{ agent: "codex", id: "fixture-selected" }],
        },
      },
    });
    await openChat(page);
    await page.getByTestId("chat-config-button").click();
    await expect(page.getByTestId("chat-config-dialog")).toContainText(prompt);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: resolve(artifacts, `${testInfo.project.name}-model-${width}.png`),
    });
    await page.keyboard.press("Escape");
    await page.getByTestId("chat-model-select").selectOption("fixture-selected");
    const marker = `chat-history-${width}-${Date.now()}`;
    const sent = page.waitForRequest((req) => req.url().endsWith("/api/chat/stream"));
    await page.getByTestId("chat-input").fill(`Reply with exactly: ${marker}.`);
    await page.getByTestId("chat-send-button").click();
    expect((await sent).postDataJSON().model).toBe("fixture-selected");
    await expect(page.getByTestId("chat-panel")).toHaveAttribute("data-streaming", "false");
    await expect(page.getByTestId("chat-message-content").last()).toContainText(marker);
    await expect(page.getByTestId("chat-message-content").first()).toContainText(
      `Reply with exactly: ${marker}.`,
    );
    await page.screenshot({
      path: resolve(artifacts, `${testInfo.project.name}-conversation-${width}.png`),
    });
    await page.reload();
    await expect(page.getByTestId("chat-input")).toBeEnabled();
    await page.getByTestId("chat-sessions-button").click();
    await page.getByTestId("chat-session-search").fill(marker);
    await page.getByTestId("chat-resume-thread").filter({ hasText: marker }).click();
    await expect(page.getByTestId("chat-message-content").last()).toContainText(marker);
    const continued = page.waitForRequest((req) => req.url().endsWith("/api/chat/stream"));
    await page.getByTestId("chat-input").fill("Follow up");
    await page.getByTestId("chat-send-button").click();
    expect((await continued).postDataJSON().threadId).toMatch(/^[a-f0-9-]{36}$/);
    await expect(page.getByTestId("chat-message-content").last()).toContainText("Follow up");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}

test("provider activity is collapsed, readable, safe and retained after completion", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const thread = {
    id: "00000000-0000-4000-8000-000000000001",
    title: "Structured fixture",
    config: defaults,
    cwd: "/fixture",
    host: null,
    backend: "codex-cli",
    runtimeId: "fixture-native",
    sourceId: null,
    messages: [],
    updatedAt: Date.now(),
  };
  const events = [
    { type: "thread", thread, runId: "00000000-0000-4000-8000-000000000002" },
    { type: "thinking", text: "Provider supplied summary" },
    {
      type: "tool_use",
      data: { id: "tool-1", name: "Read workspace", input: '{"project":"fixture"}' },
    },
    {
      type: "tool_result",
      data: {
        toolUseId: "tool-1",
        content: `<img src=x onerror="window.chatXss=true">${"x".repeat(1000)}`,
        isError: false,
      },
    },
    { type: "text", text: "Structured response finished" },
    { type: "done" },
  ];
  await page.route("**/api/chat/stream", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    }),
  );
  await openChat(page);
  await page.getByTestId("chat-input").fill("Show activity");
  await page.getByTestId("chat-send-button").click();
  const thinking = page.getByTestId("chat-thinking");
  const tool = page.getByTestId("chat-tool");
  await expect(thinking).toBeVisible();
  await expect(thinking).not.toHaveAttribute("open");
  await expect(tool).toContainText("Completed");
  await thinking.locator("summary").click();
  await expect(thinking).toContainText("Provider supplied summary");
  await tool.locator("summary").click();
  await expect(tool.locator("pre").last()).toContainText("<img src=x");
  expect(await page.evaluate(() => "chatXss" in window)).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("chat defaults save and reload through Settings", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings");
  await page.getByTestId("chat-system-prompt").fill("Saved from the mobile settings form");
  await page.getByTestId("chat-default-model").fill("fixture-settings-model");
  await page
    .getByTestId("chat-model-catalog")
    .fill("codex: fixture-settings-model\nclaude: fixture-claude-model");
  await page.getByTestId("chat-settings-save").click();
  await expect(page.getByTestId("chat-settings-feedback")).toContainText("Chat defaults saved");
  await page.reload();
  await expect(page.getByTestId("chat-default-model")).toHaveValue("fixture-settings-model");
  await expect(page.getByTestId("chat-system-prompt")).toHaveValue(
    "Saved from the mobile settings form",
  );
  await openChat(page);
  await expect(page.getByTestId("chat-model-select")).toHaveValue("fixture-settings-model");
});

test("coding-session selection opens native history before sending a continuation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const thread = {
    id: "00000000-0000-4000-8000-000000000011",
    title: "Imported coding work",
    config: defaults,
    cwd: "/fixture/repository",
    host: null,
    backend: "codex-cli",
    runtimeId: "existing-native-session",
    sourceId: "discovered-fixture",
    messages: [
      {
        id: "original-message",
        role: "assistant",
        content: "Earlier native answer",
        timestamp: Date.now(),
        agent: "codex",
      },
    ],
    updatedAt: Date.now(),
  };
  await page.route("**/api/sessions/live?**", (route) =>
    route.fulfill({
      json: {
        sessions: [
          {
            id: "discovered-fixture",
            agent: "codex",
            session_id: "existing-native-session",
            name: "Imported coding work",
            cwd: "/fixture/repository",
            status: "stopped",
            host: null,
          },
        ],
      },
    }),
  );
  await page.route("**/api/chat/threads", async (route) => {
    if (route.request().method() === "POST") {
      expect(route.request().postDataJSON()).toEqual({ sourceSessionId: "discovered-fixture" });
      await route.fulfill({ json: thread });
    } else await route.continue();
  });
  await openChat(page);
  await page.getByTestId("chat-sessions-button").click();
  await page.getByTestId("chat-resume-live").filter({ hasText: "Imported coding work" }).click();
  await expect(page.getByTestId("chat-message-content")).toContainText("Earlier native answer");
  await expect(page.getByTestId("chat-agent-select")).toBeDisabled();
  await page.getByTestId("chat-config-button").click();
  await expect(page.getByTestId("chat-config-dialog")).toContainText("/fixture/repository");
});

test("synced sessions can supply missing checkout details before chat resume", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const source = {
    id: "archive-fixture",
    agent: "codex",
    native_id: "existing-native",
    title: "Synced work without checkout metadata",
    revision: 3,
    metadata: { subdirectory: "" },
  };
  const thread = {
    id: "00000000-0000-4000-8000-000000000021",
    title: source.title,
    config: defaults,
    cwd: "/fixture/repository/packages/app",
    host: null,
    backend: "codex-cli",
    runtimeId: source.native_id,
    sourceId: "prepared-live",
    messages: [
      {
        id: "original-message",
        role: "assistant",
        content: "Synced native history",
        timestamp: Date.now(),
        agent: "codex",
      },
    ],
    updatedAt: Date.now(),
  };
  await page.route("**/api/sessions/archive?**", (route) =>
    route.fulfill({ json: { sessions: [source], has_more: false } }),
  );
  await page.route("**/api/sessions/archive/archive-fixture/resume", (route) => {
    expect(route.request().postDataJSON()).toEqual({
      revision: 3,
      repository: "https://example.test/fixture.git",
      branch: "main",
      commit: "a".repeat(40),
      subdirectory: "packages/app",
    });
    return route.fulfill({ json: { status: "ready", live_session_id: "prepared-live" } });
  });
  await page.route("**/api/chat/threads", (route) =>
    route.request().method() === "POST" ? route.fulfill({ json: thread }) : route.continue(),
  );
  await openChat(page);
  await page.getByTestId("chat-sessions-button").click();
  await page.getByTestId("chat-resume-archive").filter({ hasText: source.title }).click();
  await expect(page.getByTestId("chat-archive-prepare")).toBeDisabled();
  await page.getByTestId("chat-archive-repository").fill("https://example.test/fixture.git");
  await page.getByTestId("chat-archive-branch").fill("main");
  await page.getByTestId("chat-archive-commit").fill("a".repeat(40));
  await page.getByTestId("chat-archive-subdirectory").fill("packages/app");
  await page.getByTestId("chat-archive-prepare").click();
  await expect(page.getByTestId("chat-message-content")).toContainText("Synced native history");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
