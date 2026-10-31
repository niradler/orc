import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ChatSettingsSchema } from "@orc/core/chat";
import { expect, test } from "@playwright/test";
import { chooseChatModel, openChatSettings } from "./_chat-ui";
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

async function workspaceFixture(page: import("@playwright/test").Page, hosts = ["lab"]) {
  await page.route("**/api/ssh", (route) =>
    route.fulfill({ json: { host: null, hosts, supported: true } }),
  );
  await page.addInitScript(() => {
    localStorage.setItem(
      "orc_folder_history",
      JSON.stringify({
        local: {
          last: "/local/projects/a-long-project-name/packages/application",
          recent: ["/local/projects/a-long-project-name/packages/application", "/local/older"],
        },
        "ssh:lab": { last: "/remote/current", recent: ["/remote/current", "/remote/older"] },
      }),
    );
  });
}

test("workspace icons stay inside the composer and preserve draft and host-scoped selections", async ({
  page,
  request,
}, testInfo) => {
  await workspaceFixture(page);
  await request.patch("/api/settings", {
    headers,
    data: { chat: { ...defaults, model: "fixture-extra-long-model-name-for-compact-composer" } },
  });
  await openChat(page);
  const composer = page.getByTestId("chat-composer-box");
  const workspace = composer.getByTestId("chat-workspace");
  await expect(workspace).toBeVisible();
  await expect(composer.getByTestId("chat-model-button")).toBeVisible();
  await page.getByTestId("chat-input").fill("Keep this unsent draft while choosing a workspace");
  await expect(page.getByTestId("chat-workspace-cwd")).toBeHidden();
  const worktree = workspace.getByTestId("chat-workspace-worktree");
  await expect(worktree).toHaveAttribute("aria-pressed", "false");
  await worktree.click();
  await expect(worktree).toHaveAttribute("aria-pressed", "true");

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of ["host", "browse", "recent", "worktree"]) {
      const icon = workspace.getByTestId(`chat-workspace-${name}`);
      await expect(icon).toBeVisible();
      const bounds = await icon.boundingBox();
      expect(bounds).not.toBeNull();
      if (width < 640) {
        expect(bounds?.width).toBeGreaterThanOrEqual(44);
        expect(bounds?.height).toBeGreaterThanOrEqual(44);
      }
    }
    await workspace.getByTestId("chat-workspace-host").click();
    await expect(page.getByTestId("chat-workspace-host-option")).toHaveCount(2);
    await page.screenshot({ path: testInfo.outputPath(`workspace-host-${width}.png`) });
    await page.getByTestId("chat-workspace-host-option").filter({ hasText: "lab" }).click();
    await expect(workspace.getByTestId("chat-workspace-path")).toHaveAttribute(
      "title",
      `lab: ${width === 1440 ? "/remote/current" : "/remote/older"}`,
    );
    await workspace.getByTestId("chat-workspace-recent").click();
    const recent = page.getByTestId("chat-workspace-recent-option");
    await expect(recent).toHaveText(
      width === 1440 ? ["/remote/current", "/remote/older"] : ["/remote/older", "/remote/current"],
    );
    await page.screenshot({ path: testInfo.outputPath(`workspace-recent-${width}.png`) });
    await recent.filter({ hasText: "/remote/older" }).click();
    await expect(workspace.getByTestId("chat-workspace-path")).toHaveAttribute(
      "title",
      "lab: /remote/older",
    );
    await workspace.getByTestId("chat-workspace-host").click();
    await page.getByTestId("chat-workspace-host-option").filter({ hasText: "Local" }).click();
    await expect(workspace.getByTestId("chat-workspace-path")).toHaveAttribute(
      "title",
      "Local: /local/projects/a-long-project-name/packages/application",
    );
    await expect(worktree).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("chat-input")).toHaveValue(
      "Keep this unsent draft while choosing a workspace",
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath(`workspace-toolbar-${width}.png`) });
  }
  await workspace.getByTestId("chat-workspace-recent").click();
  await page.getByTestId("chat-workspace-cwd").fill("/local/not-applied-yet");
  await page.keyboard.press("Escape");
  await expect(workspace.getByTestId("chat-workspace-path")).toHaveAttribute(
    "title",
    "Local: /local/projects/a-long-project-name/packages/application",
  );
  await workspace.getByTestId("chat-workspace-recent").click();
  await expect(page.getByTestId("chat-workspace-cwd")).toHaveValue("/local/not-applied-yet");
  await page.getByTestId("chat-workspace-cwd").fill("");
  await page.getByTestId("chat-workspace-apply").click();
  await expect(worktree).toBeDisabled();
  await expect(worktree).toHaveAttribute("aria-pressed", "false");
  await page.screenshot({ path: testInfo.outputPath("workspace-disabled-320.png") });
  let launch: unknown;
  await page.route("**/api/chat/stream", (route) => {
    launch = route.request().postDataJSON();
    return route.fulfill({ status: 400, json: { error: "Captured default-folder launch" } });
  });
  await page.getByTestId("chat-send-button").click();
  await expect
    .poll(() => launch)
    .toMatchObject({
      workspace: { host: null, cwd: "", worktree: false },
    });
});

test("switching to a host without folder history turns off worktree and preserves the draft", async ({
  page,
}) => {
  await workspaceFixture(page, ["lab", "empty-host"]);
  await openChat(page);
  await page.getByTestId("chat-input").fill("Draft for a new execution host");
  const worktree = page.getByTestId("chat-workspace-worktree");
  await worktree.click();
  await expect(worktree).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("chat-workspace-host").click();
  await page.getByTestId("chat-workspace-host-option").filter({ hasText: "empty-host" }).click();
  await expect(page.getByTestId("chat-workspace-path")).toHaveAttribute(
    "title",
    "empty-host: Default folder",
  );
  await expect(worktree).toBeDisabled();
  await expect(worktree).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("chat-input")).toHaveValue("Draft for a new execution host");
  let launch: unknown;
  await page.route("**/api/chat/stream", (route) => {
    launch = route.request().postDataJSON();
    return route.fulfill({ status: 400, json: { error: "Captured default-folder host launch" } });
  });
  await page.getByTestId("chat-send-button").click();
  await expect
    .poll(() => launch)
    .toMatchObject({
      workspace: { host: "empty-host", cwd: "", worktree: false },
    });
});

test("native folder choice preserves cancellation and surfaces genuine picker errors", async ({
  page,
}) => {
  await workspaceFixture(page);
  let result: "cancel" | "error" | "chosen" = "cancel";
  let picks = 0;
  await page.route("**/api/terminals/pick-folder", (route) => {
    picks++;
    expect(route.request().postDataJSON()).toEqual({
      initial: "/local/projects/a-long-project-name/packages/application",
      host: null,
    });
    return result === "error"
      ? route.fulfill({ status: 500, json: { error: "Folder dialog failed to open" } })
      : route.fulfill({ json: { path: result === "cancel" ? null : "/local/chosen" } });
  });
  await openChat(page);
  await page.getByTestId("chat-input").fill("Preserve the draft");
  const browse = page.getByTestId("chat-workspace-browse");
  const path = page.getByTestId("chat-workspace-path");
  await browse.click();
  await expect.poll(() => picks).toBe(1);
  await expect(browse).toBeEnabled();
  await expect(path).toHaveAttribute(
    "title",
    "Local: /local/projects/a-long-project-name/packages/application",
  );
  await expect(page.getByTestId("remote-folder-browser")).toBeHidden();
  result = "error";
  await browse.click();
  await expect(page.getByTestId("chat-workspace-error")).toContainText(
    "Folder dialog failed to open",
  );
  await expect(page.getByTestId("remote-folder-browser")).toBeHidden();
  await expect(path).toHaveAttribute(
    "title",
    "Local: /local/projects/a-long-project-name/packages/application",
  );
  result = "chosen";
  await browse.click();
  await expect(path).toHaveAttribute("title", "Local: /local/chosen");
  await expect(page.getByTestId("chat-workspace-error")).toBeHidden();
  await expect(page.getByTestId("chat-input")).toHaveValue("Preserve the draft");
});

test("a delayed native folder result cannot change a newly selected conversation", async ({
  page,
}) => {
  await workspaceFixture(page);
  let finishPicker = () => {};
  const pendingPicker = new Promise<void>((resolvePicker) => {
    finishPicker = resolvePicker;
  });
  let requested = false;
  await page.route("**/api/terminals/pick-folder", async (route) => {
    requested = true;
    await pendingPicker;
    await route.fulfill({ json: { path: "/local/late-choice-for-first-conversation" } });
  });
  await openChat(page);
  await page.getByTestId("chat-input").fill("First conversation draft");
  await page.getByTestId("chat-workspace-browse").click();
  await expect.poll(() => requested).toBe(true);
  await expect(page.getByTestId("chat-workspace-host")).toBeDisabled();
  await page.getByTestId("chat-clear-button").filter({ visible: true }).click();
  await expect(page.getByTestId("chat-input")).toHaveValue("");
  await page.getByTestId("chat-input").fill("Second conversation draft");
  const completed = page.waitForResponse((response) =>
    response.url().endsWith("/api/terminals/pick-folder"),
  );
  finishPicker();
  await (await completed).finished();
  await expect(page.getByTestId("chat-workspace-browse")).toBeEnabled();
  await expect(page.getByTestId("chat-workspace-path")).toHaveAttribute(
    "title",
    "Local: /local/projects/a-long-project-name/packages/application",
  );
  await expect(page.getByTestId("chat-input")).toHaveValue("Second conversation draft");
});

test("headless local browsing falls back safely and remote browsing stays on its selected host", async ({
  page,
}) => {
  await workspaceFixture(page);
  let nativePicks = 0;
  await page.route("**/api/terminals/pick-folder", (route) => {
    nativePicks++;
    return route.fulfill({
      status: 400,
      json: { error: "No folder picker is available on this machine", code: "VALIDATION_ERROR" },
    });
  });
  const browseRequests: (string | null)[] = [];
  await page.route("**/api/terminals/browse?**", (route) => {
    const params = new URL(route.request().url()).searchParams;
    const host = params.get("host");
    browseRequests.push(host);
    return route.fulfill({
      json: {
        host,
        path: params.get("path"),
        parent: host === "lab" ? "/remote" : "/local",
        directories: ["child"],
      },
    });
  });
  await openChat(page);
  await page.getByTestId("chat-input").fill("Preserve the remote draft");
  await page.getByTestId("chat-workspace-browse").click();
  await expect(page.getByTestId("remote-folder-browser")).toBeVisible();
  await expect.poll(() => nativePicks).toBe(1);
  await expect.poll(() => browseRequests.length).toBeGreaterThan(0);
  expect(browseRequests.at(-1)).toBe("");
  await page.getByTestId("remote-folder-browser").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("chat-workspace-path")).toHaveAttribute(
    "title",
    "Local: /local/projects/a-long-project-name/packages/application",
  );
  await page.getByTestId("chat-workspace-host").click();
  await page.getByTestId("chat-workspace-host-option").filter({ hasText: "lab" }).click();
  await page.getByTestId("chat-workspace-browse").click();
  await expect(page.getByTestId("remote-folder-browser")).toBeVisible();
  await expect.poll(() => browseRequests.at(-1)).toBe("lab");
  expect(nativePicks).toBe(1);
  await page.getByTestId("remote-folder-name-child").dblclick();
  await expect(page.getByTestId("remote-folder-selection")).toHaveValue("/remote/current/child");
  await page.getByTestId("remote-folder-pick").click();
  await expect(page.getByTestId("chat-workspace-path")).toHaveAttribute(
    "title",
    "lab: /remote/current/child",
  );
  await expect(page.getByTestId("chat-input")).toHaveValue("Preserve the remote draft");
  await page.getByTestId("chat-workspace-worktree").click();
  let launch: unknown;
  await page.route("**/api/chat/stream", (route) => {
    launch = route.request().postDataJSON();
    return route.fulfill({ status: 400, json: { error: "Captured remote launch" } });
  });
  await page.getByTestId("chat-send-button").click();
  await expect
    .poll(() => launch)
    .toMatchObject({
      workspace: { host: "lab", cwd: "/remote/current/child", worktree: true },
    });
});
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
    await openChatSettings(page);
    await expect(page.getByTestId("chat-config-dialog")).toContainText(prompt);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: resolve(artifacts, `${testInfo.project.name}-model-${width}.png`),
    });
    await page.keyboard.press("Escape");
    await chooseChatModel(page, "fixture-selected");
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
    await page.getByTestId("chat-session-select").filter({ hasText: marker }).click();
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
  await page.goto("/settings?settingsSection=chat");
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
  await expect(page.getByTestId("chat-model-button")).toHaveText("fixture-settings-model");
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
  await page.getByTestId("chat-session-search").fill("Imported coding work");
  await page.getByTestId("chat-resume-live").filter({ hasText: "Imported coding work" }).click();
  await expect(page.getByTestId("chat-message-content")).toContainText("Earlier native answer");
  await expect(page.getByTestId("chat-agent-button")).toHaveText("codex");
  await openChatSettings(page);
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
  await page.getByTestId("chat-session-search").fill(source.title);
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
